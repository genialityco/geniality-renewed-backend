import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { maskPhone } from 'src/reminders/contact.util';
import { GenOnProgram, GenOnTriggerKey } from './schemas/genon-program.schema';
import { GenOnEnrollment } from './schemas/genon-enrollment.schema';
import { GenOnFeedback } from './schemas/genon-feedback.schema';
import { GenOnDemo, GenOnDemoParticipant } from './schemas/genon-demo.schema';
import { GenOnEngineService } from './genon-engine.service';
import { GenOnTriggersService, TRIGGER_STEP } from './genon-triggers.service';
import { GenOnTemplatesService } from './genon-templates.service';
import { GenOnContextService } from './genon-context.service';
import { withTriggerDefaults } from './genon-defaults';
import {
  DEMO_STAGES,
  DemoStage,
  DemoStep,
  findDemoStage,
  findDemoStep,
  scenarioFor,
} from './genon-demo-script';

const DAY_MS = 24 * 60 * 60 * 1000;
// Marca de todo lo que crea la demostración (para borrarlo al terminar)
export const DEMO_TAG = 'genon-demo';
const MAX_PARTICIPANTS = 30;
// Números de 10 dígitos sin indicativo se toman como de Colombia
const DEFAULT_COUNTRY_CODE = '57';

function idVariants(id: unknown): any[] {
  const raw = String(id);
  return Types.ObjectId.isValid(raw) && String(new Types.ObjectId(raw)) === raw
    ? [raw, new Types.ObjectId(raw)]
    : [raw];
}

/** Solo dígitos, con indicativo (los de 10 dígitos se toman como de Colombia). */
export function normalizeDemoPhone(input: string): string {
  const digits = String(input ?? '').replace(/\D/g, '');
  const phone = digits.length === 10 ? `${DEFAULT_COUNTRY_CODE}${digits}` : digits;
  if (phone.length < 11 || phone.length > 15) {
    throw new BadRequestException(
      'Teléfono inválido: escribe el número con indicativo (p. ej. 57 300 123 4567).',
    );
  }
  return phone;
}

export interface DemoStepReadiness {
  ready: boolean;
  reason: string | null;
}

/**
 * Demostración guiada de Gen.ON con personas reales (ver GenOnDemo y el
 * guion en genon-demo-script). Cada participante recibe un usuario ficticio
 * en un curso de la organización de prueba; preparar una etapa reescribe sus
 * datos de avance para dejarlo en esa situación, y enviar un paso usa los
 * mismos envíos reales de "Pruebas" (su teléfono, su inscripción, botones y
 * retos con efectos reales en la organización de prueba).
 *
 * Solo con el programa apagado: activo o en simulación, el cron también
 * segmentaría y les escribiría a los participantes por su cuenta.
 */
@Injectable()
export class GenOnDemoService {
  private readonly logger = new Logger(GenOnDemoService.name);

  constructor(
    @InjectModel(GenOnDemo.name) private readonly demoModel: Model<GenOnDemo>,
    @InjectModel(GenOnEnrollment.name)
    private readonly enrollmentModel: Model<GenOnEnrollment>,
    @InjectModel(GenOnFeedback.name)
    private readonly feedbackModel: Model<GenOnFeedback>,
    @InjectConnection() private readonly connection: Connection,
    private readonly engine: GenOnEngineService,
    private readonly triggers: GenOnTriggersService,
    private readonly templates: GenOnTemplatesService,
    private readonly context: GenOnContextService,
  ) {}

  private col(name: string) {
    return this.connection.collection(name);
  }

  // ───────────────────────── Sala ─────────────────────────

  /** Demostración del programa (hay una a la vez), o null. */
  async current(program: GenOnProgram): Promise<GenOnDemo | null> {
    return this.demoModel
      .findOne({ program_id: String(program._id) })
      .sort({ created_at: -1 })
      .exec();
  }

  async get(program: GenOnProgram, demoId: string): Promise<GenOnDemo> {
    const demo = Types.ObjectId.isValid(demoId)
      ? await this.demoModel.findById(demoId).exec()
      : null;
    if (!demo || demo.program_id !== String(program._id)) {
      throw new NotFoundException('Demostración no encontrada en el programa');
    }
    return demo;
  }

  async create(
    program: GenOnProgram,
    uid: string,
    body: { name?: string; eventId?: string },
  ): Promise<GenOnDemo> {
    this.requireOff(program);
    if (await this.current(program)) {
      throw new BadRequestException(
        'Ya hay una demostración en este programa: termínala antes de crear otra.',
      );
    }
    const events = await this.engine.programEvents(program);
    const event = body.eventId
      ? events.find((e: any) => String(e._id) === body.eventId)
      : events[0];
    if (!event) throw new BadRequestException('El curso no pertenece al programa');
    const organizationId = String((event as any).organizer_id);
    await this.requireTestOrganization(organizationId);
    return this.demoModel.create({
      program_id: String(program._id),
      organization_id: organizationId,
      event_id: String(event._id),
      name: String(body.name || '').trim().slice(0, 80) || 'Demostración Gen.ON',
      created_by: uid,
    });
  }

  /** Termina la demostración: borra a los participantes y todo lo suyo. */
  async remove(program: GenOnProgram, demo: GenOnDemo) {
    const userIds = demo.participants.map((p) => p.user_id);
    if (userIds.length) await this.deleteUsers(userIds);
    await this.demoModel.deleteOne({ _id: demo._id }).exec();
    return { participants_deleted: userIds.length };
  }

  // ───────────────────────── Participantes ─────────────────────────

  async addParticipant(
    program: GenOnProgram,
    demo: GenOnDemo,
    body: { name?: string; phone?: string },
  ) {
    this.requireOff(program);
    const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!name) throw new BadRequestException('Falta el nombre');
    const phone = normalizeDemoPhone(body.phone || '');
    if (demo.participants.some((p) => p.phone === phone)) {
      throw new BadRequestException('Ese teléfono ya está en la demostración');
    }
    if (demo.participants.length >= MAX_PARTICIPANTS) {
      throw new BadRequestException(`Máximo ${MAX_PARTICIPANTS} participantes por demostración`);
    }

    const now = new Date();
    const userId = new Types.ObjectId();
    const tag = { seed_tag: DEMO_TAG, demo_id: String(demo._id) };
    const [nombres, ...rest] = name.split(' ');
    const apellidos = rest.join(' ') || 'Demo';
    const email = `demo.${String(userId).slice(-8)}@prueba.com`;
    // Colombia: indicativo aparte, como en las membresías reales
    const local =
      phone.startsWith(DEFAULT_COUNTRY_CODE) && phone.length === 12
        ? { phone: phone.slice(2), indicativodepais: DEFAULT_COUNTRY_CODE }
        : { phone };

    await this.col('users').insertOne({
      _id: userId,
      uid: `demo-${String(userId)}`,
      names: name,
      email,
      phone,
      sessionTokens: [],
      createdAt: now,
      updatedAt: now,
      ...tag,
    });
    await this.col('organizationusers').insertOne({
      organization_id: new Types.ObjectId(demo.organization_id),
      user_id: userId,
      rol_id: 'attendee',
      memberShipStatus: true,
      whatsapp_opt_in: true,
      whatsapp_opt_in_at: now,
      whatsapp_opt_out_at: null,
      properties: {
        ID: `DEMO-${String(userId).slice(-6).toUpperCase()}`,
        nombres,
        apellidos,
        email,
        ...local,
        pais: 'Colombia',
        soyProfesionalSalud: true,
        consentimientoProfSalud: true,
      },
      created_at: now,
      updated_at: now,
      ...tag,
    });
    await this.col('courseattendees').insertOne({
      user_id: String(userId),
      event_id: new Types.ObjectId(demo.event_id),
      status: 'ACTIVE',
      progress: 0,
      completed_at: null,
      createdAt: now,
      updatedAt: now,
      ...tag,
    });

    const participant: GenOnDemoParticipant = {
      user_id: String(userId),
      name,
      phone,
      added_at: now,
    };
    await this.demoModel
      .updateOne({ _id: demo._id }, { $push: { participants: participant } })
      .exec();
    demo.participants.push(participant);
    // Quien llega con la demostración empezada entra a la etapa actual
    const stage = demo.stage ? findDemoStage(demo.stage) : null;
    if (stage) await this.prepare(program, demo, stage, [participant.user_id], now);
    return participant;
  }

  async removeParticipant(program: GenOnProgram, demo: GenOnDemo, userId: string) {
    if (!demo.participants.some((p) => p.user_id === userId)) {
      throw new NotFoundException('El participante no está en la demostración');
    }
    await this.deleteUsers([userId]);
    await this.demoModel
      .updateOne({ _id: demo._id }, { $pull: { participants: { user_id: userId } } })
      .exec();
    return { deleted: true };
  }

  // ───────────────────────── Etapas y envíos ─────────────────────────

  /** Deja a todos los participantes en la situación de la etapa. */
  async prepareStage(program: GenOnProgram, demo: GenOnDemo, stageKey: string) {
    this.requireOff(program);
    const stage = findDemoStage(stageKey);
    if (!stage) throw new NotFoundException('Etapa desconocida');
    if (!demo.participants.length) {
      throw new BadRequestException('Agrega participantes antes de preparar una etapa');
    }
    const now = new Date();
    await this.prepare(
      program,
      demo,
      stage,
      demo.participants.map((p) => p.user_id),
      now,
    );
    await this.demoModel
      .updateOne({ _id: demo._id }, { $set: { stage: stage.key, stage_prepared_at: now } })
      .exec();
    demo.stage = stage.key;
    demo.stage_prepared_at = now;
  }

  /**
   * Reescribe el avance de las personas con el escenario de la etapa, les
   * devuelve el consentimiento de WhatsApp en la organización de prueba y
   * las segmenta de nuevo con la conversación en limpio (sin retos, racha,
   * disparadores ni motivo de abandono anteriores).
   */
  private async prepare(
    program: GenOnProgram,
    demo: GenOnDemo,
    stage: DemoStage,
    userIds: string[],
    now: Date,
  ) {
    const course = await this.context.loadCourse(demo.event_id);
    if (!course) throw new NotFoundException('El curso de la demostración ya no existe');
    const modules = this.context.modulesOf(course);
    const scenario = scenarioFor(stage.key, {
      activityCount: course.activities.length,
      firstModuleSize: modules[0]?.activityIds.length || 1,
    });
    const quizzes = scenario.passExams
      ? await this.col('quizzes')
          .find(
            { eventId: { $in: idVariants(demo.event_id) }, enabled: { $ne: false } },
            { projection: { _id: 1 } },
          )
          .toArray()
      : [];

    await this.wipeProgress(userIds);
    const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const tag = { seed_tag: DEMO_TAG, demo_id: String(demo._id) };
    const enrolledAt = ago(scenario.enrolledDaysAgo);
    const done = scenario.completed.filter((c) => course.activities[c.index]);
    const progress = Math.round((done.length / Math.max(course.activities.length, 1)) * 100);
    const lastDone = done.length ? ago(Math.min(...done.map((c) => c.daysAgo))) : null;
    const completedAt = progress >= 100 ? lastDone : null;

    for (const userId of userIds) {
      await this.col('courseattendees').updateOne(
        { user_id: userId, event_id: new Types.ObjectId(demo.event_id) },
        {
          $set: {
            status: 'ACTIVE',
            progress,
            completed_at: completedAt,
            createdAt: enrolledAt,
            updatedAt: lastDone || enrolledAt,
            ...tag,
          },
        },
        { upsert: true },
      );
      if (done.length) {
        const activities = done.map((c) => ({
          id: course.activities[c.index].id,
          at: ago(c.daysAgo),
        }));
        await this.col('activityattendees').insertMany(
          activities.map((a) => ({
            user_id: userId,
            activity_id: a.id,
            event_id: new Types.ObjectId(demo.event_id),
            progress: 100,
            createdAt: a.at,
            updatedAt: a.at,
            ...tag,
          })),
        );
        await this.col('progress_events').insertMany([
          ...activities.map((a) => ({
            user_id: userId,
            event_id: demo.event_id,
            activity_id: a.id,
            type: 'activity_progress',
            from: 0,
            to: 100,
            at: a.at,
            created_at: a.at,
            ...tag,
          })),
          ...(completedAt
            ? [
                {
                  user_id: userId,
                  event_id: demo.event_id,
                  activity_id: null,
                  type: 'course_completed',
                  from: 0,
                  to: 100,
                  at: completedAt,
                  created_at: completedAt,
                  ...tag,
                },
              ]
            : []),
        ]);
      }
      if (quizzes.length) {
        await this.col('UserAttemptsQuiz').insertMany(
          quizzes.map((q: any, i: number) => {
            const at = ago(Math.max(1, 10 - i));
            return {
              quizId: String(q._id),
              userId,
              attemptedAt: at,
              status: 'graded',
              score: 90,
              userAnswers: [],
              manualScores: [],
              createdAt: at,
              updatedAt: at,
              ...tag,
            };
          }),
        );
      }
      // Si alguien tocó "No recibir más mensajes" en la etapa anterior
      await this.col('organizationusers').updateOne(
        {
          user_id: { $in: idVariants(userId) },
          organization_id: { $in: idVariants(demo.organization_id) },
          seed_tag: DEMO_TAG,
        },
        {
          $set: {
            whatsapp_opt_in: true,
            whatsapp_opt_in_at: enrolledAt,
            whatsapp_opt_out_at: null,
          },
        },
      );
    }

    await this.engine.resegmentPeople(program, demo.event_id, new Set(userIds), now);
    await this.enrollmentModel
      .updateMany(
        {
          program_id: String(program._id),
          event_id: demo.event_id,
          user_id: { $in: userIds },
          test: false,
        },
        {
          $set: {
            segment_since: now,
            last_step_key: null,
            last_step_day: null,
            next_step_key: null,
            next_step_at: null,
            paused: false,
            paused_at: null,
            exited: false,
            exit_reason: null,
            holdout: false,
            variant_picks: {},
            abandon_reason: null,
            awaiting_feedback: false,
            support_until: null,
            last_error: null,
            challenges: [],
            queue: [],
            fired: [],
            modules_done: null,
            streak: null,
            streak_bridged: [],
            streak_risk_week: null,
          },
        },
      )
      .exec();
  }

  /**
   * Envía un paso de la etapa actual a los participantes (todos o los
   * indicados), uno por uno. El error de uno no frena a los demás.
   */
  async sendStep(
    program: GenOnProgram,
    demo: GenOnDemo,
    stepId: string,
    userIds?: string[],
  ) {
    this.requireOff(program);
    const found = findDemoStep(stepId);
    if (!found) throw new NotFoundException('Paso desconocido');
    if (demo.stage !== found.stage.key) {
      throw new BadRequestException(`Prepara primero la etapa "${found.stage.title}".`);
    }
    const targets = demo.participants.filter(
      (p) => !userIds?.length || userIds.includes(p.user_id),
    );
    if (!targets.length) throw new BadRequestException('No hay participantes a quién enviar');

    const results: {
      user_id: string;
      name: string;
      ok: boolean;
      template: string | null;
      error: string | null;
    }[] = [];
    for (const p of targets) {
      try {
        const res = await this.sendOne(program, demo, found.step, p.user_id);
        results.push({ user_id: p.user_id, name: p.name, ok: true, template: res.template, error: null });
      } catch (error) {
        results.push({
          user_id: p.user_id,
          name: p.name,
          ok: false,
          template: null,
          error: (error as Error).message,
        });
      }
    }
    const at = new Date();
    await this.demoModel
      .updateOne(
        { _id: demo._id },
        {
          $push: {
            sends: {
              $each: results.map((r) => ({
                step_id: stepId,
                user_id: r.user_id,
                at,
                ok: r.ok,
                error: r.error,
              })),
            },
          },
        },
      )
      .exec();
    return { step_id: stepId, results };
  }

  /**
   * Toques de la secuencia: el envío real de "Pruebas". Disparadores: el
   * mensaje con los datos de la persona aunque hoy no se cumpla del todo
   * (p. ej. la comparación semanal fuera del lunes), porque el escenario de
   * la etapa ya lo deja en esa situación.
   */
  private async sendOne(program: GenOnProgram, demo: GenOnDemo, step: DemoStep, userId: string) {
    if (step.kind === 'step') {
      return this.engine.sendRealStep(program, userId, demo.event_id, step.key);
    }
    const key = step.key as GenOnTriggerKey;
    const msg = await this.triggers.buildTriggerMessage(program, userId, demo.event_id, key);
    return this.engine.sendRealTemplate(program, {
      userId,
      eventId: demo.event_id,
      templateKey: msg.templateKey,
      values: msg.values,
      urlSuffix: msg.urlSuffix,
      step: TRIGGER_STEP[key],
      actionData: msg.actionData,
    });
  }

  // ───────────────────────── Guion y estado ─────────────────────────

  /** El guion con lo que impide enviar cada paso (plantilla sin aprobar, reto sin configurar…). */
  async script(program: GenOnProgram, eventId: string | null) {
    const cfg = withTriggerDefaults(program.triggers);
    const course = eventId ? program.courses?.[eventId] : undefined;
    const approved = new Map<string, boolean>();
    const isApproved = async (key: string) => {
      if (!approved.has(key)) {
        approved.set(key, Boolean(this.engine.sendableVersion(await this.templates.byKey(key), false)));
      }
      return approved.get(key)!;
    };

    const readiness = async (step: DemoStep): Promise<DemoStepReadiness> => {
      let keys: string[];
      if (step.kind === 'step') {
        const flowStep = Object.values(program.flows || {})
          .flat()
          .find((s) => s?.key === step.key);
        if (!flowStep) return { ready: false, reason: 'El toque no existe en el programa.' };
        if (flowStep.mechanic === 'challenge_invite' && !course?.challenge_activity_ids?.length) {
          return {
            ready: false,
            reason: 'Habilita actividades para reto en "Cursos y retos".',
          };
        }
        keys = [...new Set(flowStep.variants.map((v) => v.template_key))];
      } else {
        const key = step.key as GenOnTriggerKey;
        if (key === 'video_challenge' && !course?.skippable_activity_ids?.length) {
          return {
            ready: false,
            reason: 'Marca al menos un video como saltable en "Cursos y retos".',
          };
        }
        keys = [this.triggers.templateFor(cfg, key)];
      }
      const missing: string[] = [];
      for (const key of keys) if (!(await isApproved(key))) missing.push(key);
      return missing.length
        ? {
            ready: false,
            reason: `Plantilla sin aprobar en Meta: ${missing.join(', ')}.`,
          }
        : { ready: true, reason: null };
    };

    const stages = [];
    for (const stage of DEMO_STAGES) {
      const steps = [];
      for (const s of stage.steps) {
        steps.push({
          ...s,
          // Cómo aparece en la bitácora de envíos (para cruzarlo con el estado)
          log_step: s.kind === 'trigger' ? TRIGGER_STEP[s.key as GenOnTriggerKey] : s.key,
          ...(await readiness(s)),
        });
      }
      stages.push({ ...stage, steps });
    }
    return stages;
  }

  /** Estado en vivo: qué recibió, leyó y respondió cada participante. */
  async status(program: GenOnProgram, demo: GenOnDemo) {
    const userIds = demo.participants.map((p) => p.user_id);
    const [enrollments, messages, feedback, course] = await Promise.all([
      this.enrollmentModel
        .find({
          program_id: String(program._id),
          event_id: demo.event_id,
          user_id: { $in: userIds },
          test: false,
        })
        .lean()
        .exec(),
      userIds.length
        ? this.col('engagement_messages')
            .find({
              user_id: { $in: userIds },
              program_id: String(program._id),
              at: { $gte: demo.created_at },
              status: { $ne: 'planned' },
            })
            .sort({ at: 1 })
            .toArray()
        : Promise.resolve([] as any[]),
      this.feedbackModel
        .find({ program_id: String(program._id), user_id: { $in: userIds } })
        .sort({ created_at: 1 })
        .lean()
        .exec(),
      this.context.loadCourse(demo.event_id),
    ]);
    const activityName = new Map((course?.activities || []).map((a) => [a.id, a.name]));
    const stage = demo.stage ? findDemoStage(demo.stage) : null;
    const byUser = <T extends { user_id: string }>(rows: T[]) => {
      const map = new Map<string, T[]>();
      for (const r of rows) map.set(String(r.user_id), [...(map.get(String(r.user_id)) || []), r]);
      return map;
    };
    const enrollmentByUser = new Map(enrollments.map((e) => [e.user_id, e]));
    const messagesByUser = byUser(messages as any[]);
    const feedbackByUser = byUser(feedback as any[]);

    type FeedItem = { at: Date; user_id: string; name: string; type: string; text: string };
    const feed: FeedItem[] = [];
    const participants = demo.participants.map((p) => {
      const e: any = enrollmentByUser.get(p.user_id) || null;
      const item = (at: Date | null | undefined, type: string, text: string) => {
        if (at) feed.push({ at: new Date(at), user_id: p.user_id, name: p.name, type, text });
      };
      const sent = (messagesByUser.get(p.user_id) || []).map((m: any) => {
        const label = `${m.step || m.template}`;
        if (m.status === 'failed') item(m.at, 'failed', `${label}: falló el envío`);
        else item(m.at, 'sent', `Recibió ${label}`);
        item(m.read_at, 'read', `Leyó ${label}`);
        item(m.clicked_at, 'clicked', `Abrió el enlace de ${label}`);
        item(m.replied_at, 'replied', `Respondió a ${label}: "${m.reply_text || ''}"`);
        return {
          _id: String(m._id),
          step: m.step,
          template: m.template,
          text: m.text,
          at: m.at,
          status: m.status,
          meta_status: m.meta_status,
          error: m.error || m.meta_error || null,
          delivered_at: m.delivered_at,
          read_at: m.read_at,
          clicked_at: m.clicked_at,
          replied_at: m.replied_at,
          reply_text: m.reply_text,
        };
      });
      const challenges = (e?.challenges || []).map((c: any) => {
        const kind = c.kind === 'review' ? ' de repaso' : c.kind === 'video' ? ' del video' : '';
        item(
          c.at,
          c.passed ? 'challenge_passed' : 'challenge_failed',
          `${c.passed ? 'Aprobó' : 'No aprobó'} el reto${kind} (${c.correct}/${c.total})`,
        );
        return { ...c, activity_name: activityName.get(c.activity_id) || null };
      });
      const comments = (feedbackByUser.get(p.user_id) || []).map((f: any) => {
        item(
          f.created_at,
          f.type,
          f.type === 'support' ? `Abrió un caso de soporte: ${f.text}` : `Comentó: "${f.text}"`,
        );
        return { type: f.type, text: f.text, at: f.created_at };
      });
      return {
        user_id: p.user_id,
        name: p.name,
        phone: maskPhone(p.phone),
        segment: e?.segment || null,
        expected_segment: stage?.segment || null,
        progress: e?.progress ?? 0,
        streak: e?.streak?.current ?? 0,
        abandon_reason: e?.abandon_reason || null,
        exited: Boolean(e?.exited),
        exit_reason: e?.exit_reason || null,
        awaiting_feedback: Boolean(e?.awaiting_feedback),
        enrollment_id: e ? String(e._id) : null,
        messages: sent,
        challenges,
        feedback: comments,
      };
    });
    feed.sort((a, b) => b.at.getTime() - a.at.getTime());

    return {
      _id: String(demo._id),
      name: demo.name,
      event_id: demo.event_id,
      event_name: course?.eventName || null,
      stage: demo.stage,
      stage_prepared_at: demo.stage_prepared_at,
      created_at: demo.created_at,
      sends: demo.sends,
      participants,
      feed: feed.slice(0, 150),
    };
  }

  // ───────────────────────── Conversación ─────────────────────────

  /**
   * "No recibir más mensajes" de un participante: solo da de baja su
   * membresía de prueba. La baja normal es por teléfono y lo sacaría de los
   * cursos reales de sus otras organizaciones. Devuelve false si la persona
   * no es de una demostración.
   */
  async optOutDemoMember(e: { user_id: string; organization_id: string }): Promise<boolean> {
    const res = await this.col('organizationusers').updateOne(
      {
        user_id: { $in: idVariants(e.user_id) },
        organization_id: { $in: idVariants(e.organization_id) },
        seed_tag: DEMO_TAG,
      },
      { $set: { whatsapp_opt_in: false, whatsapp_opt_in_at: null, whatsapp_opt_out_at: new Date() } },
    );
    return res.matchedCount > 0;
  }

  // ───────────────────────── Internos ─────────────────────────

  private requireOff(program: GenOnProgram) {
    if (program.mode !== 'off') {
      throw new BadRequestException(
        'Apaga el programa (modo "Apagado") mientras dure la demostración: activo o en simulación, el cron también segmentaría y les escribiría a los participantes por su cuenta.',
      );
    }
  }

  /** Solo en organizaciones de prueba: la demostración crea usuarios ficticios en el curso. */
  private async requireTestOrganization(organizationId: string) {
    const org = Types.ObjectId.isValid(organizationId)
      ? await this.col('organizations').findOne(
          { _id: new Types.ObjectId(organizationId) },
          { projection: { seed_tag: 1 } },
        )
      : null;
    if (!org?.seed_tag) {
      throw new BadRequestException(
        'La demostración solo se hace en una organización de prueba (como "[PRUEBA] Gen.ON"): crea usuarios ficticios en el curso.',
      );
    }
  }

  /** Avance, exámenes, certificados y actividad de los usuarios de la demostración. */
  private async wipeProgress(userIds: string[]) {
    const vals = userIds.flatMap(idVariants);
    await Promise.all([
      this.col('activityattendees').deleteMany({ user_id: { $in: vals } }),
      this.col('progress_events').deleteMany({ user_id: { $in: userIds } }),
      this.col('UserAttemptsQuiz').deleteMany({ userId: { $in: userIds } }),
      this.col('certificates').deleteMany({ userId: { $in: vals } }),
      this.col('useractivities').deleteMany({ user_id: { $in: vals } }),
    ]);
  }

  /** Borra usuarios de la demostración (solo los marcados) y todo lo que generaron. */
  private async deleteUsers(userIds: string[]) {
    const vals = userIds.flatMap(idVariants);
    const marked = await this.col('users')
      .find({ _id: { $in: vals.filter((v) => v instanceof Types.ObjectId) }, seed_tag: DEMO_TAG })
      .project({ _id: 1 })
      .toArray();
    const ids = marked.map((u: any) => String(u._id));
    if (ids.length !== userIds.length) {
      this.logger.warn(
        `Demostración: ${userIds.length - ids.length} usuarios sin la marca ${DEMO_TAG}; no se borran`,
      );
    }
    if (!ids.length) return;
    const idVals = ids.flatMap(idVariants);
    await this.wipeProgress(ids);
    await Promise.all([
      this.col('users').deleteMany({ _id: { $in: idVals }, seed_tag: DEMO_TAG }),
      this.col('organizationusers').deleteMany({ user_id: { $in: idVals }, seed_tag: DEMO_TAG }),
      this.col('courseattendees').deleteMany({ user_id: { $in: idVals } }),
      this.col('engagement_messages').deleteMany({ user_id: { $in: ids } }),
      this.col('auth_links').deleteMany({ user_id: { $in: ids } }),
      this.enrollmentModel.deleteMany({ user_id: { $in: ids } }).exec(),
      this.feedbackModel.deleteMany({ user_id: { $in: ids } }).exec(),
    ]);
  }
}
