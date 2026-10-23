import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CourseSnapshotsService } from 'src/course-snapshots/course-snapshots.service';
import {
  DeliveryResult,
  EngagementLogService,
  phoneTail,
} from 'src/engagement/engagement-log.service';
import { WhatsappGatewayClient } from 'src/reminders/whatsapp-gateway.client';
import { Event } from 'src/events/schemas/event.schema';
import { Organization } from 'src/organizations/schemas/organization.schema';
import { OrganizationUser } from 'src/organization-users/schemas/organization-user.schema';
import { User } from 'src/users/schemas/user.schema';
import { ProgressEvent } from 'src/progress-events/schemas/progress-event.schema';
import { AuthLinksService } from 'src/auth-links/auth-links.service';
import { hasWhatsappConsent } from 'src/common/whatsapp-consent';
import {
  resolveEmail,
  resolveName,
  resolvePhone,
} from 'src/reminders/contact.util';
import {
  GenOnFlowSegment,
  GenOnProgram,
  GenOnSegment,
  GenOnStep,
  GenOnVariant,
} from './schemas/genon-program.schema';
import { GenOnEnrollment } from './schemas/genon-enrollment.schema';
import { GenOnTemplate } from './schemas/genon-template.schema';
import { GenOnTemplatesService } from './genon-templates.service';
import {
  CourseData,
  CourseStats,
  GenOnContextService,
  PersonContext,
} from './genon-context.service';
import {
  classifySegment,
  isHoldout,
  localDate,
  nextStep,
  orderedSteps,
  pickVariant,
  slotFor,
  spreadSlots,
  stepSendTime,
  validSlots,
  zonedTime,
} from './genon-schedule';
import {
  buildSendComponents,
  extractVariables,
  renderText,
} from './genon-variables';

const DAY_MS = 24 * 60 * 60 * 1000;
const FLOW_SEGMENTS: GenOnFlowSegment[] = ['abandon', 'inactive'];
const NO_CHALLENGE_REASON =
  'Este usuario no tiene una actividad para el reto: ya completó las habilitadas o no tienen preguntas suficientes. El envío real omitiría este toque; habilita más actividades en Cursos y retos.';
/** Asignaciones por variante en esta pasada, por toque y grupo ("1.2:envio") */
type VariantCounts = Map<string, Record<string, number>>;

/** Clave del toque en `variant_picks` ("1.2" → "1_2": el punto anida en Mongo). */
const pickKey = (stepKey: string) => stepKey.replace(/\./g, '_');

// Envíos máximos por programa en cada ejecución del cron (cada 15 min)
export const MAX_SENDS_PER_RUN = 40;
// Al reprogramar (segmentar, reasignar), una franja de hoy que pasó hace
// menos de esto aún sale hoy (atrasada) en vez de correrse al día siguiente:
// la segmentación corre antes del despacho y el cron va cada 15 min
export const RESCHEDULE_GRACE_MS = 60 * 60 * 1000;

function idVariants(id: unknown): any[] {
  const raw = String(id);
  return Types.ObjectId.isValid(raw) && String(new Types.ObjectId(raw)) === raw
    ? [raw, new Types.ObjectId(raw)]
    : [raw];
}

/**
 * Payload de un botón de respuesta rápida: "gn:<inscripción>:<acción>". El
 * reto del video lleva además el id del video, que solo se conoce al enviar.
 */
export function buttonPayload(
  enrollmentId: string,
  action: string | undefined,
  data?: Record<string, string>,
): string {
  if (action === 'challenge_video' && data?.video_id) {
    return `gn:${enrollmentId}:challenge_video:${data.video_id}`;
  }
  return `gn:${enrollmentId}:${action}`;
}

export interface Person {
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  consent: boolean;
}

/** Lo que pasó con un inscrito en una ejecución (para el reporte y las pruebas). */
export interface DispatchOutcome {
  enrollment_id: string;
  user_id: string;
  event_id: string;
  segment: GenOnSegment;
  step: string | null;
  result:
    | 'sent'
    | 'fallback_email'
    | 'planned'
    | 'holdout'
    | 'capped'
    | 'duplicate'
    | 'skipped'
    | 'error';
  reason?: string;
}

interface CourseCache {
  course: CourseData;
  stats: CourseStats;
}

/**
 * Motor de Gen.ON: clasifica a diario a los inscritos de cada programa por
 * segmento y envía los toques de su secuencia cuando les toca, en su franja,
 * respetando el tope semanal y el grupo de control.
 */
@Injectable()
export class GenOnEngineService {
  private readonly logger = new Logger(GenOnEngineService.name);

  constructor(
    @InjectModel(GenOnProgram.name)
    private readonly programModel: Model<GenOnProgram>,
    @InjectModel(GenOnEnrollment.name)
    private readonly enrollmentModel: Model<GenOnEnrollment>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Organization.name)
    private readonly organizationModel: Model<Organization>,
    @InjectModel(OrganizationUser.name)
    private readonly organizationUserModel: Model<OrganizationUser>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly templates: GenOnTemplatesService,
    private readonly context: GenOnContextService,
    private readonly snapshots: CourseSnapshotsService,
    private readonly engagementLog: EngagementLogService,
    private readonly gateway: WhatsappGatewayClient,
    @InjectModel(ProgressEvent.name)
    private readonly progressEventModel: Model<ProgressEvent>,
    private readonly authLinks?: AuthLinksService,
  ) {}

  // ───────────────────────── Ejecución ─────────────────────────

  /**
   * Una pasada del programa: segmenta si aún no se hizo hoy (o si se fuerza)
   * y despacha los toques que ya tocan. En simulación nada se envía.
   */
  async runProgram(
    program: GenOnProgram,
    now: Date,
    opts: {
      forceSegment?: boolean;
      dryRun?: boolean;
      budget?: number;
      /** Solo en simulación: también planea lo programado hasta esta hora */
      planUntil?: Date;
    } = {},
  ) {
    const dryRun = opts.dryRun || program.mode === 'dry_run';
    const today = localDate(now, program.timezone);
    let segmentation: Awaited<ReturnType<typeof this.segment>> | null = null;
    if (opts.forceSegment || program.last_segmented_on !== today) {
      segmentation = await this.segment(program, now);
      await this.programModel
        .updateOne(
          { _id: program._id },
          { $set: { last_segmented_on: today, last_run_at: now } },
        )
        .exec();
    } else {
      await this.programModel
        .updateOne({ _id: program._id }, { $set: { last_run_at: now } })
        .exec();
    }
    const outcomes = await this.dispatch(
      program,
      now,
      dryRun,
      opts.budget ?? MAX_SENDS_PER_RUN,
      dryRun ? opts.planUntil : undefined,
    );
    return { segmentation, outcomes };
  }

  /** Cursos del programa: los elegidos o todos los de sus organizaciones. */
  async programEvents(program: GenOnProgram) {
    const filter: Record<string, any> = program.event_ids?.length
      ? {
          _id: {
            $in: program.event_ids
              .filter((id) => Types.ObjectId.isValid(id))
              .map((id) => new Types.ObjectId(id)),
          },
        }
      : {
          organizer_id: {
            $in: program.organization_ids.flatMap((id) => idVariants(id)),
          },
        };
    const events = await this.eventModel.collection
      .find(filter, { projection: { name: 1, organizer_id: 1 } })
      .toArray();
    // Por seguridad, solo cursos de las organizaciones del programa
    const orgs = new Set(program.organization_ids.map(String));
    return events.filter((e: any) => orgs.has(String(e.organizer_id)));
  }

  // ───────────────────────── Segmentación ─────────────────────────

  async segment(program: GenOnProgram, now: Date) {
    const counts: Record<string, number> = {};
    let courses = 0;
    for (const event of await this.programEvents(program)) {
      try {
        const n = await this.segmentEvent(program, event as any, now);
        if (n === null) continue;
        courses++;
        for (const [k, v] of Object.entries(n)) counts[k] = (counts[k] || 0) + v;
      } catch (error) {
        this.logger.warn(
          `Gen.ON: segmentación del curso ${String(event._id)} falló: ${(error as Error).message}`,
        );
      }
    }
    await this.reactivateOptedIn(program);
    return { courses, counts };
  }

  private async segmentEvent(
    program: GenOnProgram,
    event: { _id: any; name?: string; organizer_id: any },
    now: Date,
    /** Solo estas personas (las estadísticas del curso siguen siendo de todos) */
    onlyUsers?: Set<string>,
  ): Promise<Record<string, number> | null> {
    const eventId = String(event._id);
    const orgId = String(event.organizer_id);
    const { rows } = await this.snapshots.computeEvent(event, orgId, now);
    if (!rows.length) return null;
    const course = await this.context.loadCourse(eventId);
    if (!course) return null;
    const progressByUser = new Map(
      rows.map((r) => [r.user_id, r.course_progress]),
    );
    const stats = await this.context.loadStats(course, progressByUser, now);

    const existing = new Map(
      (
        await this.enrollmentModel
          .find({ program_id: String(program._id), event_id: eventId, test: false })
          .exec()
      ).map((e) => [e.user_id, e]),
    );

    const counts: Record<string, number> = {};
    const ops: any[] = [];
    for (const row of rows) {
      if (onlyUsers && !onlyUsers.has(row.user_id)) continue;
      const completed = stats.completedByUser.get(row.user_id)?.size || 0;
      const segment = classifySegment(
        {
          progress: row.course_progress,
          completedActivities: completed,
          enrolledAt: row.enrolled_at,
          lastActivityAt: row.last_activity_at,
        },
        program.segments,
        now,
      );
      counts[segment] = (counts[segment] || 0) + 1;

      const e = existing.get(row.user_id);
      const base = {
        progress: row.course_progress,
        completed_activities: completed,
        last_activity_at: row.last_activity_at,
        enrolled_at: row.enrolled_at,
      };
      // Si la franja ya no está en el programa, se sortea otra
      const slot =
        e?.slot && validSlots(program.send_slots).includes(e.slot)
          ? e.slot
          : slotFor(String(program._id), row.user_id, program.send_slots);
      let state: Record<string, any>;
      if (!e || e.segment !== segment) {
        // Entra a un segmento nuevo: la secuencia empieza de cero
        state = {
          segment,
          segment_since: now,
          last_step_key: null,
          last_step_day: null,
          paused: false,
          paused_at: null,
          awaiting_feedback: false,
          holdout: isHoldout(
            String(program._id),
            row.user_id,
            segment,
            program.holdout_percent?.[segment],
          ),
        };
      } else {
        state = {
          segment: e.segment,
          segment_since: e.segment_since,
          last_step_key: e.last_step_key,
          last_step_day: e.last_step_day,
          paused: e.paused,
        };
      }
      const exited = e?.exited || false;
      const schedule =
        !exited && !state.paused
          ? this.schedule(program, state as any, slot, now, RESCHEDULE_GRACE_MS)
          : { next_step_key: null, next_step_at: null };

      ops.push({
        updateOne: {
          filter: {
            program_id: String(program._id),
            event_id: eventId,
            user_id: row.user_id,
            test: false,
          },
          update: {
            $set: { ...base, ...state, ...schedule, slot, segmented_at: now },
            $setOnInsert: { organization_id: orgId, exited: false },
          },
          upsert: true,
        },
      });
    }
    for (let i = 0; i < ops.length; i += 500) {
      await this.enrollmentModel.bulkWrite(ops.slice(i, i + 500), {
        ordered: false,
      });
    }
    return counts;
  }

  /** Próximo toque y su hora (null si el segmento no tiene secuencia o terminó). */
  private schedule(
    program: GenOnProgram,
    state: {
      segment: GenOnSegment;
      segment_since: Date;
      last_step_key: string | null;
      last_step_day: number | null;
    },
    slot: string,
    now: Date,
    graceMs = 0,
  ): { next_step_key: string | null; next_step_at: Date | null } {
    if (!FLOW_SEGMENTS.includes(state.segment as GenOnFlowSegment)) {
      return { next_step_key: null, next_step_at: null };
    }
    const step = nextStep(
      program.flows?.[state.segment as GenOnFlowSegment] || [],
      state.last_step_key,
      state.last_step_day,
    );
    if (!step) return { next_step_key: null, next_step_at: null };
    return {
      next_step_key: step.key,
      next_step_at: stepSendTime({
        segmentSince: new Date(state.segment_since),
        day: step.day,
        slot,
        timeZone: program.timezone,
        blockedWeekdays: program.blocked_weekdays,
        now: new Date(now.getTime() - graceMs),
      }),
    };
  }

  /**
   * Reparte de nuevo a todos los inscritos por igual entre las franjas
   * actuales y borra las variantes asignadas (el próximo envío de cada toque
   * las vuelve a repartir). La hora del próximo toque se recalcula con la
   * franja nueva. Segmenta antes (no envía nada) para que también reparta a
   * quienes aún no tienen inscripción, p. ej. justo después de activar el
   * programa, que borra las de la simulación. No marca la segmentación del
   * día: la pasada diaria del cron (con sus disparadores) sigue igual.
   */
  async reassign(program: GenOnProgram, now: Date) {
    await this.segment(program, now);
    const all = await this.enrollmentModel
      .find({ program_id: String(program._id), test: false })
      .select(
        'user_id segment segment_since last_step_key last_step_day paused exited variant_picks',
      )
      .lean()
      .exec();
    const slots = spreadSlots(
      String(program._id),
      all.map((e) => e.user_id),
      program.send_slots,
    );

    const bySlot: Record<string, number> = {};
    let variantsCleared = 0;
    const ops = all.map((e) => {
      const slot = slots.get(e.user_id)!;
      bySlot[slot] = (bySlot[slot] || 0) + 1;
      if (Object.keys(e.variant_picks || {}).length) variantsCleared++;
      // Pausados y retirados conservan su estado; solo cambia la franja
      const schedule =
        !e.exited && !e.paused
          ? this.schedule(program, e as any, slot, now, RESCHEDULE_GRACE_MS)
          : {};
      return {
        updateOne: {
          filter: { _id: e._id },
          update: { $set: { slot, variant_picks: {}, ...schedule } },
        },
      };
    });
    for (let i = 0; i < ops.length; i += 500) {
      await this.enrollmentModel.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    }
    return {
      enrollments: all.length,
      people: slots.size,
      by_slot: bySlot,
      variants_cleared: variantsCleared,
    };
  }

  /** Quien respondió VOLVER (o reactivó WhatsApp) vuelve a su secuencia. */
  private async reactivateOptedIn(program: GenOnProgram) {
    const exited = await this.enrollmentModel
      .find({
        program_id: String(program._id),
        exited: true,
        exit_reason: 'opt_out',
        test: false,
      })
      .select('user_id organization_id')
      .lean()
      .exec();
    for (const e of exited) {
      const orgUser: any = await this.organizationUserModel.collection.findOne(
        {
          user_id: { $in: idVariants(e.user_id) },
          organization_id: { $in: idVariants(e.organization_id) },
        },
        { projection: { whatsapp_opt_out_at: 1 } },
      );
      if (orgUser && !orgUser.whatsapp_opt_out_at) {
        await this.enrollmentModel
          .updateOne(
            { _id: e._id },
            {
              $set: {
                exited: false,
                exit_reason: null,
                segment_since: new Date(),
                last_step_key: null,
                last_step_day: null,
                paused: false,
              },
            },
          )
          .exec();
      }
    }
  }

  // ───────────────────────── Despacho ─────────────────────────

  /**
   * Envía ya el próximo toque programado de cada persona, sin esperar su
   * franja (botón "Enviar ya lo programado"). Respeta tope, grupo de control,
   * consentimiento y el resto de reglas del despacho normal.
   */
  async dispatchAhead(program: GenOnProgram, now: Date, dryRun: boolean, budget: number) {
    return this.dispatch(program, now, dryRun, budget, undefined, true);
  }

  private async dispatch(
    program: GenOnProgram,
    now: Date,
    dryRun: boolean,
    budget: number,
    planUntil?: Date,
    ahead = false,
  ): Promise<DispatchOutcome[]> {
    const until = planUntil && planUntil > now ? planUntil : now;
    const due = await this.enrollmentModel
      .find({
        program_id: String(program._id),
        test: false,
        exited: false,
        paused: false,
        segment: { $in: FLOW_SEGMENTS },
        next_step_at: ahead ? { $ne: null } : { $ne: null, $lte: until },
      })
      .sort({ next_step_at: 1 })
      .limit(budget)
      .exec();

    const cache = new Map<string, CourseCache | null>();
    const counts: VariantCounts = new Map();
    const { due: still, outcomes } = await this.resegmentMoved(program, due, now);
    for (const e of still) {
      try {
        let entry = cache.get(e.event_id);
        if (entry === undefined) {
          entry = await this.loadCourseCache(program, e.event_id, now);
          cache.set(e.event_id, entry);
        }
        if (!entry) {
          outcomes.push(this.outcome(e, null, 'skipped', 'curso no encontrado'));
          continue;
        }
        // Lo planeado por adelantado queda registrado a la hora en que saldría
        // (al adelantarlo a mano, sale ahora)
        const at =
          !ahead && e.next_step_at && new Date(e.next_step_at) > now
            ? new Date(e.next_step_at)
            : now;
        outcomes.push(await this.dispatchOne(program, e, entry, counts, dryRun, at));
      } catch (error) {
        const reason = (error as Error).message;
        await this.retryTomorrow(program, e, now, reason);
        outcomes.push(this.outcome(e, e.next_step_key, 'error', reason));
      }
    }
    return outcomes;
  }

  /**
   * La segmentación es diaria: quien avanzó en el curso desde la última se
   * resegmenta antes de enviarle su toque. Si ya no está en el mismo segmento
   * (p. ej. en abandono y empezó el curso esta mañana), el toque no sale.
   */
  private async resegmentMoved(
    program: GenOnProgram,
    due: GenOnEnrollment[],
    now: Date,
  ): Promise<{ due: GenOnEnrollment[]; outcomes: DispatchOutcome[] }> {
    if (!due.length) return { due, outcomes: [] };
    // Inscripciones anteriores a segmented_at: se segmentaron hoy de madrugada
    const startOfDay = zonedTime(localDate(now, program.timezone), '00:00', program.timezone);
    const sinceOf = (e: GenOnEnrollment) =>
      e.segmented_at ? new Date(e.segmented_at) : startOfDay;
    const progress = await this.progressEventModel.collection
      .find(
        {
          user_id: { $in: due.map((e) => e.user_id) },
          event_id: { $in: [...new Set(due.map((e) => e.event_id))] },
          at: { $gt: new Date(Math.min(...due.map((e) => sinceOf(e).getTime()))) },
        },
        { projection: { user_id: 1, event_id: 1, at: 1 } },
      )
      .toArray();
    const moved = due.filter((e) =>
      progress.some(
        (p: any) =>
          p.user_id === e.user_id &&
          p.event_id === e.event_id &&
          new Date(p.at) > sinceOf(e),
      ),
    );
    if (!moved.length) return { due, outcomes: [] };

    const byEvent = new Map<string, Set<string>>();
    for (const e of moved) {
      byEvent.set(e.event_id, (byEvent.get(e.event_id) || new Set()).add(e.user_id));
    }
    for (const [eventId, users] of byEvent) {
      await this.resegmentPeople(program, eventId, users, now);
    }

    const fresh = new Map(
      (await this.enrollmentModel.find({ _id: { $in: moved.map((e) => e._id) } }).exec()).map(
        (e) => [String(e._id), e],
      ),
    );
    const still: GenOnEnrollment[] = [];
    const outcomes: DispatchOutcome[] = [];
    for (const e of due) {
      const f = fresh.get(String(e._id));
      if (!f) {
        still.push(e);
      } else if (f.segment === e.segment) {
        still.push(f);
      } else {
        outcomes.push(
          this.outcome(e, e.next_step_key, 'skipped', `avanzó en el curso: pasó a ${f.segment}`),
        );
      }
    }
    return { due: still, outcomes };
  }

  /** Segmenta ya a estas personas de un curso (crea su inscripción si no la tienen). */
  async resegmentPeople(
    program: GenOnProgram,
    eventId: string,
    userIds: Set<string>,
    now: Date,
  ) {
    if (!Types.ObjectId.isValid(eventId)) return;
    const event = await this.eventModel.collection.findOne(
      { _id: new Types.ObjectId(eventId) },
      { projection: { name: 1, organizer_id: 1 } },
    );
    if (event) await this.segmentEvent(program, event as any, now, userIds);
  }

  async loadCourseCache(
    program: GenOnProgram,
    eventId: string,
    now: Date,
  ): Promise<CourseCache | null> {
    const course = await this.context.loadCourse(eventId);
    if (!course) return null;
    // El avance de cada inscrito sale de la última segmentación
    const all = await this.enrollmentModel
      .find({ program_id: String(program._id), event_id: eventId, test: false })
      .select('user_id progress')
      .lean()
      .exec();
    const progressByUser = new Map(all.map((e) => [e.user_id, e.progress || 0]));
    const stats = await this.context.loadStats(course, progressByUser, now);
    return { course, stats };
  }

  private async dispatchOne(
    program: GenOnProgram,
    e: GenOnEnrollment,
    { course, stats }: CourseCache,
    counts: VariantCounts,
    dryRun: boolean,
    now: Date,
  ): Promise<DispatchOutcome> {
    const segment = e.segment as GenOnFlowSegment;
    const steps = program.flows?.[segment] || [];
    const step =
      orderedSteps(steps).find((s) => s.key === e.next_step_key) ||
      nextStep(steps, e.last_step_key, e.last_step_day);
    if (!step) {
      await this.pause(e, now);
      return this.outcome(e, null, 'skipped', 'secuencia terminada');
    }

    const person = await this.resolvePerson(e.organization_id, e.user_id);
    if (!person.phone || !person.consent) {
      const reason = !person.phone ? 'sin teléfono' : 'sin consentimiento';
      await this.advance(program, e, step, now, reason);
      return this.outcome(e, step.key, 'skipped', reason);
    }

    const ctx = this.context.forPerson(
      program,
      course,
      stats,
      {
        userId: e.user_id,
        fullName: person.name,
        email: person.email,
        progress: e.progress,
      },
      segment,
    );
    const variant = await this.assignVariant(program, e, step, ctx, counts);
    if (!variant) {
      await this.advance(program, e, step, now, 'dato social bajo el umbral');
      return this.outcome(e, step.key, 'skipped', 'dato social bajo el umbral');
    }
    if (step.mechanic === 'challenge_invite' && !ctx.challengeActivity) {
      const reason = 'sin actividad habilitada para reto con preguntas suficientes';
      await this.advance(program, e, step, now, reason);
      return this.outcome(e, step.key, 'skipped', reason);
    }

    const delivery = await this.deliverTemplate(program, e, person, {
      templateKey: variant.template_key,
      values: ctx.values,
      urlSuffix: ctx.urlSuffix,
      // Por día: si el tope lo frena hoy, mañana se intenta con otra clave
      dedupeKey: `genon:${String(e._id)}:${new Date(e.segment_since).getTime()}:${step.key}:${localDate(now, program.timezone)}`,
      segment,
      step: step.key,
      holdout: e.holdout,
      dryRun,
      at: now,
    });

    if (delivery.result === 'not_approved') {
      await this.retryTomorrow(program, e, now, delivery.reason!);
      return this.outcome(e, step.key, 'skipped', delivery.reason);
    }
    if (delivery.result === 'missing_data') {
      await this.advance(program, e, step, now, delivery.reason!);
      return this.outcome(e, step.key, 'skipped', delivery.reason);
    }
    if (delivery.result === 'capped') {
      await this.retryTomorrow(program, e, now, 'tope semanal');
      return this.outcome(e, step.key, 'capped');
    }
    await this.advance(program, e, step, now, null);
    return this.outcome(e, step.key, delivery.result);
  }

  /**
   * Envía (o simula) una plantilla a un inscrito: versión aprobada (o el
   * borrador en simulación), variables completas, bitácora con tope y grupo
   * de control, y payload de los botones. La usan la secuencia (segmentos 1
   * y 2) y los disparadores (segmento 3, examen, certificado).
   */
  async deliverTemplate(
    program: GenOnProgram,
    e: GenOnEnrollment,
    person: Person,
    params: {
      templateKey: string;
      values: Record<string, string | number | null>;
      urlSuffix: string;
      dedupeKey: string;
      segment: string;
      step: string;
      holdout: boolean;
      dryRun: boolean;
      /** Datos de los botones (p. ej. id del video del reto) */
      actionData?: Record<string, string>;
      /** Hora del registro (en simulación, la hora en que saldría) */
      at?: Date;
    },
  ): Promise<{
    result: DeliveryResult | 'not_approved' | 'missing_data';
    reason?: string;
  }> {
    const template = await this.templates.byKey(params.templateKey);
    const version = this.sendableVersion(template, params.dryRun);
    if (!version) {
      return {
        result: 'not_approved',
        reason: `plantilla "${params.templateKey}" sin aprobar en Meta`,
      };
    }
    const missing = version.variables.filter(
      (v) =>
        params.values[v] === null ||
        params.values[v] === undefined ||
        params.values[v] === '',
    );
    if (missing.length) {
      return { result: 'missing_data', reason: `faltan datos: ${missing.join(', ')}` };
    }

    await this.enrollmentModel
      .updateOne({ _id: e._id }, { $set: { phone_tail: phoneTail(person.phone) } })
      .exec();
    // Acceso directo en los enlaces (solo envíos reales); la bitácora guarda
    // el texto sin el token
    const access = await this.withAccess(program, e, params);
    const result = await this.engagementLog.deliver(
      {
        dedupeKey: params.dedupeKey,
        kind: 'genon',
        userId: e.user_id,
        organizationId: e.organization_id,
        eventId: e.event_id,
        template: version.meta_name,
        phone: person.phone,
        programId: String(program._id),
        segment: params.segment,
        step: params.step,
        progress: e.progress ?? null,
        completedActivities: e.completed_activities ?? null,
        text: renderText(version.body, params.values),
        weeklyCap: program.weekly_cap,
        holdout: params.holdout,
        dryRun: params.dryRun,
        at: params.at,
      },
      (ref) =>
        this.gateway.sendTemplateComponents({
          to: person.phone!,
          templateName: version.meta_name,
          languageCode: version.language,
          components: buildSendComponents({
            variables: version.variables,
            values: access.values,
            buttons: version.buttons,
            urlSuffix: this.engagementLog.withClickRef(access.urlSuffix, ref),
            payloadFor: (b) =>
              buttonPayload(String(e._id), b.action, params.actionData),
          }),
        }),
    );
    return { result };
  }

  /**
   * Valores y sufijo del botón con el acceso directo, si el programa lo tiene
   * activo y es un envío real a un inscrito (no simulación ni prueba).
   */
  private async withAccess(
    program: GenOnProgram,
    e: GenOnEnrollment,
    params: { values: Record<string, string | number | null>; urlSuffix: string; dryRun: boolean },
  ) {
    const plain = { values: params.values, urlSuffix: params.urlSuffix };
    if (!program.auto_login_links || params.dryRun || e.test || !this.authLinks) return plain;
    const token = await this.authLinks.create(e.user_id, e.organization_id, 'genon');
    if (!token) return plain;
    const values: Record<string, string | number | null> = {};
    for (const [k, v] of Object.entries(params.values)) {
      values[k] = typeof v === 'string' ? this.authLinks.addToText(v, e.organization_id, token) : v;
    }
    return {
      values,
      urlSuffix: params.urlSuffix
        ? AuthLinksService.withToken(params.urlSuffix, token)
        : params.urlSuffix,
    };
  }

  /** Variantes cuyas condiciones se cumplen todas (ninguna = se omite). */
  eligibleVariants(step: GenOnStep, ctx: PersonContext): GenOnVariant[] {
    return (step.variants || []).filter((v) =>
      (v.conditions || []).every(
        (c) => (ctx.metrics[c.metric] ?? 0) >= Number(c.min),
      ),
    );
  }

  /**
   * Variante que recibiría la persona, sin guardar nada (vista previa y
   * pruebas): la que ya tiene asignada si sigue cumpliendo; si no, la de su
   * sorteo.
   */
  chooseVariant(
    program: GenOnProgram,
    step: GenOnStep,
    ctx: PersonContext,
    userId: string,
    picks?: GenOnEnrollment['variant_picks'] | null,
  ): GenOnVariant | null {
    const eligible = this.eligibleVariants(step, ctx);
    const stored = picks?.[pickKey(step.key)]?.template_key;
    return (
      eligible.find((v) => v.template_key === stored) ||
      pickVariant(eligible, `${String(program._id)}:${userId}:${step.key}`)
    );
  }

  /**
   * Asigna la variante del toque y la guarda. Si la persona puede recibir
   * varias, le toca la menos asignada en el programa (dentro de su grupo:
   * control o no), así quedan repartidas por igual; la conserva mientras
   * siga cumpliendo sus condiciones.
   */
  private async assignVariant(
    program: GenOnProgram,
    e: GenOnEnrollment,
    step: GenOnStep,
    ctx: PersonContext,
    counts: VariantCounts,
  ): Promise<GenOnVariant | null> {
    const eligible = this.eligibleVariants(step, ctx);
    const key = pickKey(step.key);
    const stored = e.variant_picks?.[key];
    const kept = eligible.find((v) => v.template_key === stored?.template_key);
    if (kept) return kept;

    const free = eligible.length > 1;
    const countKey = `${step.key}:${e.holdout ? 'control' : 'envio'}`;
    let tally = counts.get(countKey);
    if (free && !tally) {
      tally = await this.variantCounts(program, key, e.holdout);
      counts.set(countKey, tally);
    }
    const variant = pickVariant(
      eligible,
      `${String(program._id)}:${e.user_id}:${step.key}`,
      tally,
    );
    if (!variant) return null;

    // La asignación anterior (ya no cumple) deja de contar
    if (tally && stored?.free) {
      tally[stored.template_key] = Math.max(0, (tally[stored.template_key] || 0) - 1);
    }
    if (tally && free) {
      tally[variant.template_key] = (tally[variant.template_key] || 0) + 1;
    }
    await this.enrollmentModel
      .updateOne(
        { _id: e._id },
        {
          $set: {
            [`variant_picks.${key}`]: {
              template_key: variant.template_key,
              free,
              at: new Date(),
            },
          },
        },
      )
      .exec();
    return variant;
  }

  /** Variantes ya asignadas a la persona (su inscripción real, no la de prueba). */
  private async storedPicks(program: GenOnProgram, eventId: string, userId: string) {
    const e = await this.enrollmentModel
      .findOne({ program_id: String(program._id), event_id: eventId, user_id: userId, test: false })
      .select('variant_picks')
      .lean()
      .exec();
    return e?.variant_picks || null;
  }

  /** Asignaciones libres de cada variante de un toque en el programa. */
  private async variantCounts(
    program: GenOnProgram,
    key: string,
    holdout: boolean,
  ): Promise<Record<string, number>> {
    const path = `variant_picks.${key}`;
    const rows = await this.enrollmentModel
      .aggregate([
        {
          $match: {
            program_id: String(program._id),
            test: false,
            holdout: holdout ? true : { $ne: true },
            [`${path}.free`]: true,
          },
        },
        { $group: { _id: `$${path}.template_key`, n: { $sum: 1 } } },
      ])
      .exec();
    return Object.fromEntries(rows.map((r: any) => [String(r._id), r.n]));
  }

  /**
   * Versión de la plantilla que se puede enviar: la aprobada. En simulación
   * se acepta el borrador, para ver el plan antes de aprobar en Meta.
   */
  sendableVersion(template: GenOnTemplate | null, allowDraft: boolean) {
    if (!template) return null;
    if (template.approved) return template.approved;
    if (!allowDraft) return null;
    return {
      meta_name: template.meta_name || `genon_${template.key}_borrador`,
      language: template.language,
      body: template.body,
      variables: extractVariables(template.body),
      buttons: template.buttons,
      version: template.version,
      approved_at: null as any,
    };
  }

  /** Pasa al siguiente toque (o a pausa si era el cierre o el último). */
  private async advance(
    program: GenOnProgram,
    e: GenOnEnrollment,
    step: GenOnStep,
    now: Date,
    reason: string | null,
  ) {
    const state = {
      segment: e.segment,
      segment_since: e.segment_since,
      last_step_key: step.key,
      last_step_day: step.day,
    };
    const next =
      step.mechanic === 'closing'
        ? { next_step_key: null, next_step_at: null }
        : this.schedule(program, state, e.slot || '12:00', now);
    const paused = !next.next_step_key;
    await this.enrollmentModel
      .updateOne(
        { _id: e._id },
        {
          $set: {
            last_step_key: step.key,
            last_step_day: step.day,
            ...next,
            paused,
            paused_at: paused ? now : null,
            last_touch_at: now,
            last_error: reason,
          },
        },
      )
      .exec();
  }

  private async pause(e: GenOnEnrollment, now: Date) {
    await this.enrollmentModel
      .updateOne(
        { _id: e._id },
        { $set: { paused: true, paused_at: now, next_step_at: null, next_step_key: null } },
      )
      .exec();
  }

  /** El mismo toque, en la franja del siguiente día permitido. */
  private async retryTomorrow(
    program: GenOnProgram,
    e: GenOnEnrollment,
    now: Date,
    reason: string,
  ) {
    const at = stepSendTime({
      segmentSince: new Date(now.getTime() + DAY_MS),
      day: 0,
      slot: e.slot || '12:00',
      timeZone: program.timezone,
      blockedWeekdays: program.blocked_weekdays,
      now,
    });
    await this.enrollmentModel
      .updateOne(
        { _id: e._id },
        { $set: { next_step_at: at, last_error: reason } },
      )
      .exec();
  }

  private outcome(
    e: GenOnEnrollment,
    step: string | null,
    result: DispatchOutcome['result'],
    reason?: string,
  ): DispatchOutcome {
    return {
      enrollment_id: String(e._id),
      user_id: e.user_id,
      event_id: e.event_id,
      segment: e.segment,
      step,
      result,
      ...(reason ? { reason } : {}),
    };
  }

  // ───────────────────────── Personas ─────────────────────────

  async resolvePerson(organizationId: string, userId: string): Promise<Person> {
    const [orgUser, user, organization]: any[] = await Promise.all([
      this.organizationUserModel.collection.findOne({
        user_id: { $in: idVariants(userId) },
        organization_id: { $in: idVariants(organizationId) },
      }),
      Types.ObjectId.isValid(userId)
        ? this.userModel.collection.findOne(
            { _id: new Types.ObjectId(userId) },
            { projection: { names: 1, email: 1, phone: 1 } },
          )
        : null,
      Types.ObjectId.isValid(organizationId)
        ? this.organizationModel.collection.findOne(
            { _id: new Types.ObjectId(organizationId) },
            { projection: { whatsapp_consent_property: 1 } },
          )
        : null,
    ]);
    return {
      userId,
      name: resolveName(orgUser, user),
      email: resolveEmail(orgUser, user) || '',
      phone: resolvePhone(orgUser, user),
      consent: hasWhatsappConsent(orgUser, organization?.whatsapp_consent_property),
    };
  }

  // ───────────────────────── Seguimiento ─────────────────────────

  /** Inscritos del programa con su estado en el flujo y su nombre. */
  async listEnrollments(
    program: GenOnProgram,
    filter: { segment?: string; eventId?: string; limit?: number },
  ) {
    const query: Record<string, any> = {
      program_id: String(program._id),
      test: false,
    };
    if (filter.segment) query.segment = filter.segment;
    if (filter.eventId) query.event_id = filter.eventId;
    const [rows, bySegment] = await Promise.all([
      this.enrollmentModel
        .find(query)
        .sort({ next_step_at: 1, updated_at: -1 })
        .limit(Math.min(Math.max(filter.limit || 300, 1), 2000))
        .lean()
        .exec(),
      this.enrollmentModel.aggregate([
        {
          $match: {
            program_id: String(program._id),
            test: false,
            ...(filter.eventId ? { event_id: filter.eventId } : {}),
          },
        },
        {
          $group: {
            _id: '$segment',
            total: { $sum: 1 },
            holdout: { $sum: { $cond: ['$holdout', 1, 0] } },
            paused: { $sum: { $cond: ['$paused', 1, 0] } },
            exited: { $sum: { $cond: ['$exited', 1, 0] } },
          },
        },
      ]),
    ]);

    const userIds = [...new Set(rows.map((r) => r.user_id))];
    const objectIds = userIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    const [orgUsers, users, events] = await Promise.all([
      this.organizationUserModel.collection
        .find(
          { user_id: { $in: [...userIds, ...objectIds] } },
          { projection: { user_id: 1, organization_id: 1, properties: 1 } },
        )
        .toArray(),
      this.userModel.collection
        .find({ _id: { $in: objectIds } }, { projection: { names: 1, email: 1 } })
        .toArray(),
      this.eventModel.collection
        .find(
          {
            _id: {
              $in: [...new Set(rows.map((r) => r.event_id))]
                .filter((id) => Types.ObjectId.isValid(id))
                .map((id) => new Types.ObjectId(id)),
            },
          },
          { projection: { name: 1 } },
        )
        .toArray(),
    ]);
    const orgUserByKey = new Map(
      orgUsers.map((o: any) => [`${String(o.user_id)}:${String(o.organization_id)}`, o]),
    );
    const userById = new Map(users.map((u: any) => [String(u._id), u]));
    const eventName = new Map(events.map((e: any) => [String(e._id), e.name]));

    return {
      by_segment: bySegment.map((s) => ({
        segment: s._id,
        total: s.total,
        holdout: s.holdout,
        paused: s.paused,
        exited: s.exited,
      })),
      rows: rows.map((r) => {
        const orgUser = orgUserByKey.get(`${r.user_id}:${r.organization_id}`) || null;
        const user = userById.get(r.user_id) || null;
        return {
          _id: String(r._id),
          user_id: r.user_id,
          name: resolveName(orgUser, user),
          email: resolveEmail(orgUser, user) || '',
          event_id: r.event_id,
          event_name: eventName.get(r.event_id) || '',
          segment: r.segment,
          segment_since: r.segment_since,
          progress: r.progress,
          completed_activities: r.completed_activities,
          last_activity_at: r.last_activity_at,
          holdout: r.holdout,
          slot: r.slot,
          last_step_key: r.last_step_key,
          next_step_key: r.next_step_key,
          next_step_at: r.next_step_at,
          paused: r.paused,
          exited: r.exited,
          exit_reason: r.exit_reason,
          abandon_reason: r.abandon_reason,
          last_error: r.last_error,
          challenges: r.challenges || [],
          streak: r.streak || null,
          queue: (r.queue || []).map((q) => ({
            key: q.key,
            due_at: q.due_at,
            expires_at: q.expires_at,
          })),
        };
      }),
    };
  }

  /** Actividades de un curso del programa, con lo necesario para configurar retos. */
  async courseDetail(program: GenOnProgram, eventId: string) {
    const course = await this.context.loadCourse(eventId);
    if (!course || !program.organization_ids.includes(course.organizationId)) {
      throw new NotFoundException('El curso no pertenece al programa');
    }
    const config = program.courses?.[eventId];
    const enabled = new Set(config?.challenge_activity_ids || []);
    const skippable = new Set(config?.skippable_activity_ids || []);
    return {
      event_id: eventId,
      event_name: course.eventName,
      num_questions: program.challenge?.num_questions || 3,
      activities: course.activities.map((a, i) => ({
        id: a.id,
        order: i + 1,
        name: a.name,
        module_name: a.module_name,
        challenge_questions: course.questions.get(a.id)?.eligible || 0,
        topic: course.questions.get(a.id)?.topic || null,
        video_minutes: a.video_seconds ? Math.round(a.video_seconds / 60) : null,
        minutes: config?.activity_minutes?.[a.id] ?? null,
        challenge_enabled: enabled.has(a.id),
        skippable: skippable.has(a.id),
      })),
    };
  }

  // ───────────────────────── Pruebas ─────────────────────────

  /**
   * Cómo ve el motor a un usuario en un curso: su segmento hoy, si está en el
   * grupo de control, el próximo toque y cuándo saldría, y las variables.
   */
  async simulate(program: GenOnProgram, userId: string, eventId: string) {
    const now = new Date();
    const { course, stats, row } = await this.loadForUser(program, userId, eventId, now);
    const completed = stats.completedByUser.get(userId)?.size || 0;
    const segment = classifySegment(
      {
        progress: row.course_progress,
        completedActivities: completed,
        enrolledAt: row.enrolled_at,
        lastActivityAt: row.last_activity_at,
      },
      program.segments,
      now,
    );
    const enrollment = await this.enrollmentModel
      .findOne({ program_id: String(program._id), event_id: eventId, user_id: userId, test: false })
      .lean()
      .exec();
    const slot = enrollment?.slot || slotFor(String(program._id), userId, program.send_slots);
    const sameSegment = enrollment?.segment === segment;
    const state = {
      segment,
      segment_since: sameSegment ? enrollment!.segment_since : now,
      last_step_key: sameSegment ? enrollment!.last_step_key : null,
      last_step_day: sameSegment ? enrollment!.last_step_day : null,
    };
    const schedule =
      sameSegment && (enrollment!.paused || enrollment!.exited)
        ? { next_step_key: null, next_step_at: null }
        : this.schedule(program, state, slot, now);
    const person = await this.resolvePerson(course.organizationId, userId);
    const ctx = this.context.forPerson(
      program,
      course,
      stats,
      { userId, fullName: person.name, email: person.email, progress: row.course_progress },
      segment,
    );
    return {
      segment,
      holdout: isHoldout(String(program._id), userId, segment, program.holdout_percent?.[segment]),
      slot,
      progress: row.course_progress,
      completed_activities: completed,
      last_activity_at: row.last_activity_at,
      enrolled_at: row.enrolled_at,
      contact: {
        name: person.name,
        has_phone: Boolean(person.phone),
        consent: person.consent,
      },
      enrollment: enrollment
        ? {
            segment: enrollment.segment,
            last_step_key: enrollment.last_step_key,
            next_step_key: enrollment.next_step_key,
            next_step_at: enrollment.next_step_at,
            paused: enrollment.paused,
            exited: enrollment.exited,
            exit_reason: enrollment.exit_reason,
            last_error: enrollment.last_error,
          }
        : null,
      next_step: schedule,
      challenge_activity: ctx.challengeActivity?.name ?? null,
      values: ctx.values,
      metrics: ctx.metrics,
    };
  }

  /**
   * Texto de un toque con los datos reales del usuario: la variante que se
   * elegiría (o la indicada) y las variables que faltan.
   */
  async preview(
    program: GenOnProgram,
    userId: string,
    eventId: string,
    stepKey: string,
    variantIndex?: number,
  ) {
    const { step, segment } = this.findStep(program, stepKey);
    const now = new Date();
    const { course, stats, row } = await this.loadForUser(program, userId, eventId, now);
    const person = await this.resolvePerson(course.organizationId, userId);
    const ctx = this.context.forPerson(
      program,
      course,
      stats,
      { userId, fullName: person.name, email: person.email, progress: row.course_progress },
      segment,
    );
    const picks = await this.storedPicks(program, eventId, userId);
    const chosen = this.chooseVariant(program, step, ctx, userId, picks);
    const variant =
      variantIndex !== undefined && step.variants[variantIndex]
        ? step.variants[variantIndex]
        : chosen;
    if (!variant) {
      return {
        step: step.key,
        skipped: true,
        reason: 'Ninguna variante cumple sus condiciones: este toque se omitiría.',
        metrics: ctx.metrics,
      };
    }
    if (step.mechanic === 'challenge_invite' && !ctx.challengeActivity) {
      return {
        step: step.key,
        skipped: true,
        reason: NO_CHALLENGE_REASON,
        metrics: ctx.metrics,
      };
    }
    const template = await this.templates.byKey(variant.template_key);
    if (!template) throw new NotFoundException(`No existe la plantilla "${variant.template_key}"`);
    const body = template.approved?.body || template.body;
    const buttons = template.approved?.buttons || template.buttons;
    const missing = extractVariables(body).filter(
      (v) => ctx.values[v] === null || ctx.values[v] === undefined || ctx.values[v] === '',
    );
    return {
      step: step.key,
      skipped: false,
      variant: step.variants.indexOf(variant),
      chosen_variant: chosen ? step.variants.indexOf(chosen) : null,
      template_key: template.key,
      template_status: template.meta_status,
      approved: Boolean(template.approved),
      text: renderText(body, ctx.values),
      buttons: buttons.map((b) => b.text),
      missing,
      metrics: ctx.metrics,
    };
  }

  /**
   * Envía un toque a un teléfono de prueba con los datos reales del usuario.
   * La conversación (botones, reto) sigue en ese teléfono con una inscripción
   * de prueba: no marca actividades ni cuenta en las métricas.
   */
  async sendTest(
    program: GenOnProgram,
    userId: string,
    eventId: string,
    stepKey: string,
    to: string,
  ) {
    const phone = to;
    const { step, segment } = this.findStep(program, stepKey);
    const now = new Date();
    const { course, stats, row } = await this.loadForUser(program, userId, eventId, now);
    const person = await this.resolvePerson(course.organizationId, userId);
    const ctx = this.context.forPerson(
      program,
      course,
      stats,
      { userId, fullName: person.name, email: person.email, progress: row.course_progress },
      segment,
    );
    if (step.mechanic === 'challenge_invite' && !ctx.challengeActivity) {
      throw new BadRequestException(NO_CHALLENGE_REASON);
    }
    const picks = await this.storedPicks(program, eventId, userId);
    const variant =
      this.chooseVariant(program, step, ctx, userId, picks) || step.variants[0];
    return this.sendTestTemplate(program, {
      userId,
      eventId,
      organizationId: course.organizationId,
      segment,
      progress: row.course_progress,
      lastStepKey: step.key,
      lastStepDay: step.day,
      templateKey: variant.template_key,
      values: ctx.values,
      urlSuffix: ctx.urlSuffix,
      to: phone,
    });
  }

  /**
   * Envía una plantilla aprobada a un teléfono de prueba con una inscripción
   * de prueba (los botones y el reto siguen ahí sin marcar nada ni contar en
   * las métricas). La usan los toques de la secuencia y los disparadores.
   */
  async sendTestTemplate(
    program: GenOnProgram,
    params: {
      userId: string;
      eventId: string;
      organizationId: string;
      segment: GenOnSegment;
      progress: number;
      lastStepKey: string | null;
      lastStepDay: number | null;
      templateKey: string;
      values: Record<string, string | number | null>;
      urlSuffix: string;
      to: string;
      actionData?: Record<string, string>;
    },
  ) {
    const phone = String(params.to || '').replace(/\D/g, '');
    if (phone.length < 10) throw new BadRequestException('Teléfono de prueba inválido');
    if (!this.gateway.hasTemplateApi) {
      throw new BadRequestException(
        'Faltan WHATSAPP_GATEWAY_URL o WHATSAPP_GATEWAY_API_KEY en el servidor',
      );
    }
    const template = await this.templates.byKey(params.templateKey);
    const version = this.sendableVersion(template, false);
    if (!version) {
      throw new BadRequestException(
        `La plantilla "${params.templateKey}" no está aprobada en Meta: envíala y actualiza su estado en Plantillas.`,
      );
    }

    const test = await this.enrollmentModel
      .findOneAndUpdate(
        {
          program_id: String(program._id),
          event_id: params.eventId,
          user_id: params.userId,
          test: true,
        },
        {
          $set: {
            organization_id: params.organizationId,
            segment: params.segment,
            segment_since: new Date(),
            last_step_key: params.lastStepKey,
            last_step_day: params.lastStepDay,
            progress: params.progress,
            phone_tail: phoneTail(phone),
            test_phone: phone,
            exited: false,
            paused: false,
            awaiting_feedback: false,
          },
        },
        { upsert: true, new: true },
      )
      .exec();

    let components: ReturnType<typeof buildSendComponents>;
    try {
      components = buildSendComponents({
        variables: version.variables,
        values: params.values,
        buttons: version.buttons,
        urlSuffix: params.urlSuffix,
        payloadFor: (b) => buttonPayload(String(test._id), b.action, params.actionData),
      });
    } catch (error) {
      // El envío real omite el toque; en la prueba se explica por qué
      throw new BadRequestException(
        `${(error as Error).message}. Con este usuario el envío real omitiría este mensaje.`,
      );
    }
    const outcome = await this.gateway.sendTemplateComponents({
      to: phone,
      templateName: version.meta_name,
      languageCode: version.language,
      components,
    });
    return {
      sent: true,
      message_id: outcome.messageId,
      template: version.meta_name,
      text: renderText(version.body, params.values),
    };
  }

  private findStep(program: GenOnProgram, stepKey: string) {
    for (const segment of FLOW_SEGMENTS) {
      const step = (program.flows?.[segment] || []).find((s) => s.key === stepKey);
      if (step) return { step, segment };
    }
    throw new NotFoundException(`El toque "${stepKey}" no existe en el programa`);
  }

  /** Estado de un usuario en un curso (calcula el curso completo). */
  async loadForUser(
    program: GenOnProgram,
    userId: string,
    eventId: string,
    now: Date,
  ) {
    if (!(program.event_ids?.length ? program.event_ids.includes(eventId) : true)) {
      throw new BadRequestException('El curso no pertenece al programa');
    }
    const course = await this.context.loadCourse(eventId);
    if (!course || !program.organization_ids.includes(course.organizationId)) {
      throw new BadRequestException('El curso no pertenece a las organizaciones del programa');
    }
    const event = { _id: new Types.ObjectId(eventId), name: course.eventName, organizer_id: course.organizationId };
    const { rows } = await this.snapshots.computeEvent(event, course.organizationId, now);
    const row = rows.find((r) => r.user_id === String(userId));
    if (!row) throw new NotFoundException('El usuario no está inscrito en este curso');
    const stats = await this.context.loadStats(
      course,
      new Map(rows.map((r) => [r.user_id, r.course_progress])),
      now,
    );
    return { course, stats, row };
  }
}
