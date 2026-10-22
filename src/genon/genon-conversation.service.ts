import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  InboundHandler,
  WhatsappInboundService,
} from 'src/ai-evaluations/whatsapp-inbound.service';
import {
  PracticeEngineService,
  PracticeFinishResult,
} from 'src/ai-evaluations/practice-engine.service';
import { PracticeSession } from 'src/ai-evaluations/schemas/practice-session.schema';
import { ActivityQuestion } from 'src/ai-evaluations/schemas/activity-question.schema';
import { QuestionUsageService } from 'src/ai-evaluations/question-usage.service';
import { activityLink, normalizeText, shuffleArray } from 'src/ai-evaluations/practice-format';
import { OutboundMessage } from 'src/reminders/whatsapp-gateway.client';
import { ActivityAttendeeService } from 'src/activity-attendee/activity-attendee.service';
import { WhatsappOptOutService } from 'src/engagement/whatsapp-opt-out.service';
import { EngagementLogService, phoneTail } from 'src/engagement/engagement-log.service';
import { GenOnEnrollment } from './schemas/genon-enrollment.schema';
import { GenOnFeedback } from './schemas/genon-feedback.schema';
import {
  GenOnAction,
  GenOnProgram,
  GenOnReply,
} from './schemas/genon-program.schema';
import {
  CourseActivity,
  CourseData,
  GenOnContextService,
  isChallengeQuestion,
} from './genon-context.service';
import { GenOnTriggersService } from './genon-triggers.service';
import { withTriggerDefaults } from './genon-defaults';
import { GenOnEngineService } from './genon-engine.service';
import { renderText } from './genon-variables';

const DAY_MS = 24 * 60 * 60 * 1000;
const SUPPORT_WINDOW_DAYS = 7;
const HELP_WORD = 'ayuda';
// Títulos de botones interactivos: máximo 20 caracteres
const BUTTON_TITLE_MAX = 20;

type ChallengeKind = 'advance' | 'any' | 'review' | 'video';

function idVariants(id: unknown): any[] {
  const raw = String(id);
  return Types.ObjectId.isValid(raw) && String(new Types.ObjectId(raw)) === raw
    ? [raw, new Types.ObjectId(raw)]
    : [raw];
}

/**
 * Conversación de Gen.ON por WhatsApp: los botones de sus plantillas
 * (payload "gn:<inscripción>:<acción>"), las respuestas configuradas, los
 * comentarios y casos de soporte, y los retos de conocimiento (que corren
 * como sesiones del motor de simulacros con trigger "genon").
 */
@Injectable()
export class GenOnConversationService implements OnModuleInit, InboundHandler {
  readonly name = 'genon';
  private readonly logger = new Logger(GenOnConversationService.name);

  constructor(
    @InjectModel(GenOnProgram.name)
    private readonly programModel: Model<GenOnProgram>,
    @InjectModel(GenOnEnrollment.name)
    private readonly enrollmentModel: Model<GenOnEnrollment>,
    @InjectModel(GenOnFeedback.name)
    private readonly feedbackModel: Model<GenOnFeedback>,
    @InjectModel(ActivityQuestion.name)
    private readonly questionModel: Model<ActivityQuestion>,
    private readonly inbound: WhatsappInboundService,
    private readonly practice: PracticeEngineService,
    private readonly usage: QuestionUsageService,
    private readonly attendees: ActivityAttendeeService,
    private readonly optOut: WhatsappOptOutService,
    private readonly engagementLog: EngagementLogService,
    private readonly context: GenOnContextService,
    private readonly engine: GenOnEngineService,
    private readonly triggers: GenOnTriggersService,
  ) {}

  onModuleInit() {
    this.inbound.registerHandler(this);
    this.practice.registerFinishHook('genon', (session, result) =>
      this.onChallengeFinished(session, result),
    );
  }

  // ───────────────────────── Entrada ─────────────────────────

  async matches(phone: string, text: string, replyId?: string): Promise<boolean> {
    if (replyId?.startsWith('gn:')) return true;
    const e = await this.pendingFor(phone);
    if (!e) return false;
    if (e.awaiting_feedback) return true;
    return (
      normalizeText(text) === HELP_WORD &&
      Boolean(e.support_until && e.support_until.getTime() > Date.now())
    );
  }

  async handle(
    phone: string,
    text: string,
    replyId?: string,
  ): Promise<OutboundMessage[] | null> {
    if (replyId?.startsWith('gn:')) {
      const [, enrollmentId, ...rest] = replyId.split(':');
      const action = rest.join(':') as GenOnAction;
      const e = await this.findEnrollment(enrollmentId, phone);
      if (!e) return null;
      const program = await this.programModel.findById(e.program_id).exec();
      if (!program) return null;
      return this.runAction(program, e, action, phone);
    }

    const e = await this.pendingFor(phone);
    if (!e) return null;
    const program = await this.programModel.findById(e.program_id).exec();
    if (!program) return null;

    if (e.awaiting_feedback) {
      await this.feedbackModel.create({
        ...this.feedbackBase(e, phone),
        type: 'comment',
        text: text.slice(0, 2000),
      });
      await this.enrollmentModel
        .updateOne({ _id: e._id }, { $set: { awaiting_feedback: false } })
        .exec();
      return this.replyMessages(program, e, 'feedback_thanks');
    }

    // AYUDA después de "Problemas para ingresar"
    await this.feedbackModel.create({
      ...this.feedbackBase(e, phone),
      type: 'support',
      text: 'Pidió AYUDA por WhatsApp',
    });
    await this.enrollmentModel
      .updateOne({ _id: e._id }, { $set: { support_until: null } })
      .exec();
    return this.replyMessages(program, e, 'help');
  }

  /** Inscripción con una conversación pendiente para ese teléfono. */
  private async pendingFor(phone: string): Promise<GenOnEnrollment | null> {
    const tail = phoneTail(phone);
    if (!tail) return null;
    return this.enrollmentModel
      .findOne({
        phone_tail: tail,
        $or: [
          { awaiting_feedback: true },
          { support_until: { $gt: new Date() } },
        ],
      })
      .sort({ updated_at: -1 })
      .exec();
  }

  /** El botón debe tocarlo el mismo teléfono al que se envió. */
  private async findEnrollment(
    id: string,
    phone: string,
  ): Promise<GenOnEnrollment | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const e = await this.enrollmentModel.findById(id).exec();
    if (!e || !e.phone_tail || e.phone_tail !== phoneTail(phone)) return null;
    return e;
  }

  private async runAction(
    program: GenOnProgram,
    e: GenOnEnrollment,
    action: GenOnAction,
    phone: string,
  ): Promise<OutboundMessage[]> {
    if (action === 'challenge') return this.startChallenge(program, e, phone, 'advance');
    if (action === 'challenge_any') return this.startChallenge(program, e, phone, 'any');
    if (action === 'challenge_review') {
      return this.startChallenge(program, e, phone, 'review');
    }
    if (String(action).startsWith('challenge_video')) {
      const videoId = String(action).split(':')[1];
      return this.startChallenge(program, e, phone, 'video', videoId);
    }
    const key = String(action).replace(/^reply:/, '');
    const reply = this.findReply(program, key);
    if (!reply) return ['Gracias por tu respuesta. 🙌'];

    const updates: Record<string, any> = {};
    // Respuesta a la pregunta de abandono: se guarda el motivo
    if (e.last_step_key && this.isAbandonQuestion(program, e.last_step_key)) {
      updates.abandon_reason = key;
    }
    if (reply.effect === 'support_case') {
      await this.feedbackModel.create({
        ...this.feedbackBase(e, phone),
        type: 'support',
        text: reply.label,
      });
      updates.support_until = new Date(Date.now() + SUPPORT_WINDOW_DAYS * DAY_MS);
    } else if (reply.effect === 'feedback') {
      // La secuencia se detiene y el comentario llega al equipo académico
      updates.awaiting_feedback = true;
      updates.exited = true;
      updates.exit_reason = 'not_expected';
      updates.next_step_at = null;
    } else if (reply.effect === 'opt_out') {
      updates.exited = true;
      updates.exit_reason = 'opt_out';
      updates.next_step_at = null;
      // En pruebas no se da de baja el teléfono del admin
      if (!e.test) {
        await this.optOut.optOutByPhone(phone);
        await this.engagementLog.markOptOut(phone).catch(() => undefined);
      }
    }
    if (Object.keys(updates).length) {
      await this.enrollmentModel.updateOne({ _id: e._id }, { $set: updates }).exec();
    }
    return this.replyMessages(program, e, key);
  }

  private isAbandonQuestion(program: GenOnProgram, stepKey: string): boolean {
    return Object.values(program.flows || {}).some((steps) =>
      (steps || []).some((s) => s.key === stepKey && s.mechanic === 'abandon_question'),
    );
  }

  private findReply(program: GenOnProgram, key: string): GenOnReply | null {
    return (program.replies || []).find((r) => r.key === key) || null;
  }

  /** Texto configurado con las variables de la persona (y sus botones). */
  private async replyMessages(
    program: GenOnProgram,
    e: GenOnEnrollment,
    key: string,
  ): Promise<OutboundMessage[]> {
    const reply = this.findReply(program, key);
    if (!reply) return [];
    const values = await this.personValues(program, e);
    const body = renderText(reply.text, values);
    if (!reply.buttons?.length) return [body];
    return [
      {
        body,
        buttons: reply.buttons.slice(0, 3).map((b) => ({
          id: `gn:${String(e._id)}:${b.action}`,
          title: b.title.slice(0, BUTTON_TITLE_MAX),
        })),
      },
    ];
  }

  private async personValues(program: GenOnProgram, e: GenOnEnrollment) {
    const course = await this.context.loadCourse(e.event_id);
    if (!course) return {};
    const stats = await this.userStats(course, e.user_id);
    const person = await this.engine.resolvePerson(e.organization_id, e.user_id);
    return this.context.forPerson(
      program,
      course,
      stats,
      { userId: e.user_id, fullName: person.name, email: person.email, progress: e.progress },
      e.segment,
    ).values;
  }

  /** Solo las actividades completadas de la persona (sin datos sociales). */
  private async userStats(course: CourseData, userId: string) {
    return this.context.loadStats(course, new Map([[userId, 0]]), new Date());
  }

  private feedbackBase(e: GenOnEnrollment, phone: string) {
    return {
      program_id: e.program_id,
      organization_id: e.organization_id,
      event_id: e.event_id,
      user_id: e.user_id,
      enrollment_id: String(e._id),
      phone,
    };
  }

  // ───────────────────────── Reto ─────────────────────────

  /**
   * Arranca un reto según el botón:
   * - advance: marca la actividad si lo supera (primera o pendiente)
   * - any: de avance si hay actividad elegible; si no, de repaso
   * - review: sobre lo último que estudió; cuenta para la racha
   * - video: preguntas para saltar un video marcado como saltable
   */
  private async startChallenge(
    program: GenOnProgram,
    e: GenOnEnrollment,
    phone: string,
    kind: ChallengeKind,
    videoId?: string,
  ): Promise<OutboundMessage[]> {
    const course = await this.context.loadCourse(e.event_id);
    if (!course) return ['Este curso ya no está disponible.'];
    const stats = await this.userStats(course, e.user_id);
    const completed = stats.completedByUser.get(e.user_id) || new Set<string>();
    const completedAt = stats.completedAt.get(e.user_id);
    const segment = e.segment === 'abandon' ? 'abandon' : 'inactive';
    const triggers = withTriggerDefaults(program.triggers);
    const cfg = program.challenge;
    const needed = Math.max(1, cfg.num_questions || 3);

    let activity: CourseActivity | null = null;
    let finalKind: 'advance' | 'review' | 'video' = 'advance';
    if (kind === 'video') {
      const skippable = program.courses?.[e.event_id]?.skippable_activity_ids || [];
      const video = course.activities.find((a) => a.id === videoId);
      if (video && skippable.includes(video.id) && !completed.has(video.id)) {
        activity = video;
        finalKind = 'video';
      }
    } else if (kind === 'advance') {
      activity = this.context.challengeActivityFor(program, course, segment, completed);
    } else {
      if (kind === 'any') {
        activity = this.context.challengeActivityFor(program, course, segment, completed);
      }
      if (!activity) {
        activity = this.context.reviewActivityFor(course, completedAt, needed);
        finalKind = 'review';
      }
    }

    const person = await this.engine.resolvePerson(e.organization_id, e.user_id);
    const base = this.context.forPerson(
      program,
      course,
      stats,
      { userId: e.user_id, fullName: person.name, email: person.email, progress: e.progress },
      segment,
    ).values;
    if (!activity) return [renderText(cfg.unavailable_text, base)];

    const num =
      finalKind === 'video'
        ? Math.max(1, triggers.video_challenge.num_questions || 1)
        : needed;
    const values = {
      ...base,
      actividad_reto: activity.name,
      video: activity.name,
      tema_actividad: course.questions.get(activity.id)?.topic || activity.name,
      num_preguntas: num,
      link_reto: activityLink(course.organizationId, activity.id),
    };

    // Un reintento por actividad cada retry_after_days (el repaso no tiene límite)
    const last = [...(e.challenges || [])]
      .reverse()
      .find((c) => c.activity_id === activity!.id && (c.kind || 'advance') === finalKind);
    if (
      finalKind !== 'review' &&
      last &&
      !last.passed &&
      Date.now() - new Date(last.at).getTime() < (cfg.retry_after_days || 0) * DAY_MS
    ) {
      return [renderText(cfg.retry_wait_text, values)];
    }

    const [bank, used] = await Promise.all([
      this.questionModel
        .find({ activity_id: { $in: idVariants(activity.id) }, enabled: true })
        .lean()
        .exec(),
      this.usage.usedQuestionIds(e.user_id),
    ]);
    const eligible = bank.filter((q) => isChallengeQuestion(q as any));
    // Preguntas distintas en el reintento, si el banco las tiene
    const fresh = eligible.filter((q) => !used.has(String(q._id)));
    const pool = fresh.length >= num ? fresh : eligible;
    if (pool.length < num) {
      return [renderText(cfg.unavailable_text, values)];
    }
    const questions = shuffleArray(pool).slice(0, num);

    await this.enrollmentModel
      .updateOne({ _id: e._id }, { $set: { awaiting_feedback: false } })
      .exec();
    const intro =
      finalKind === 'video'
        ? `Responde esta pregunta sobre _${activity.name}_. Si aciertas, lo marcamos como visto y sigues. 👇`
        : renderText(cfg.intro_text, values);
    return this.practice.startChallenge({
      userId: e.user_id,
      userName: person.name,
      email: person.email,
      phone,
      organizationId: course.organizationId,
      eventId: course.eventId,
      eventName: course.eventName,
      activityId: activity.id,
      activityName: activity.name,
      questions: questions as unknown as ActivityQuestion[],
      trigger: 'genon',
      genon: {
        program_id: e.program_id,
        enrollment_id: String(e._id),
        step: e.last_step_key,
        activity_id: activity.id,
        // El repaso y el video exigen acertar todo; el de avance, lo configurado
        pass_percent: finalKind === 'advance' ? cfg.pass_percent : 100,
        test: e.test,
        kind: finalKind,
      },
      intro,
    });
  }

  /**
   * Cierre del reto:
   * - avance aprobado: la actividad queda terminada y pasa a activos;
   * - video aprobado: el video queda como visto;
   * - repaso aprobado: no cambia el avance, pero el día cuenta para la racha;
   * - no aprobado: enlace para repasar (cada pregunta fallada ya trajo su
   *   enlace al minuto del video).
   * Cualquier reto superado recupera la racha si estaba recién cortada.
   */
  async onChallengeFinished(
    session: PracticeSession,
    result: PracticeFinishResult,
  ): Promise<string | null> {
    const g = session.genon;
    if (!g || result.status !== 'completed') return null;
    const e = await this.enrollmentModel.findById(g.enrollment_id).exec();
    const program = e ? await this.programModel.findById(e.program_id).exec() : null;
    if (!e || !program) return null;
    const kind = g.kind || 'advance';
    const triggers = withTriggerDefaults(program.triggers);

    const passed =
      result.total > 0 &&
      result.answered === result.total &&
      (result.correct / result.total) * 100 >= (g.pass_percent ?? 100);

    // El repaso no cambia el avance; avance y video marcan la actividad
    if (passed && !g.test && kind !== 'review') {
      await this.attendees.createOrUpdate(String(session.user_id), g.activity_id, 100);
    }

    const course = await this.context.loadCourse(e.event_id);
    const stats = course ? await this.userStats(course, e.user_id) : null;
    const completed = new Set(stats?.completedByUser.get(e.user_id) || []);
    if (passed && kind !== 'review') completed.add(g.activity_id);
    const activity = course?.activities.find((a) => a.id === g.activity_id);
    const next = course?.activities.find((a) => !completed.has(a.id)) || null;
    const base = await this.personValues(program, e);

    const update: Record<string, any> = {
      $push: {
        challenges: {
          activity_id: g.activity_id,
          at: new Date(),
          passed,
          correct: result.correct,
          total: result.total,
          kind,
        },
      },
    };
    if (passed && !g.test && kind === 'advance') {
      // Completó una actividad: pasa a activos y la secuencia se detiene
      update.$set = {
        segment: 'active',
        segment_since: new Date(),
        last_step_key: null,
        last_step_day: null,
        next_step_at: null,
        next_step_key: null,
        paused: false,
      };
    }
    await this.enrollmentModel.updateOne({ _id: e._id }, update).exec();

    let racha = e.streak?.current || 0;
    if (passed && !g.test) {
      const fresh = await this.enrollmentModel.findById(e._id).exec();
      racha = await this.triggers.applyChallengeToStreak(program, fresh || e, new Date());
    }

    const minutes = course
      ? this.context.minutesFor(program, course.eventId, activity || null)
      : base.min_actividad;
    const values = {
      ...base,
      aciertos: result.correct,
      total: result.total,
      racha,
      actividad_reto: activity?.name || 'la actividad',
      video: activity?.name || 'el video',
      link_reto: activityLink(session.organization_id, g.activity_id),
      min_actividad: minutes,
      min_video: minutes,
      actividad_siguiente: next?.name || 'el resto del curso',
      link_siguiente: next ? activityLink(session.organization_id, next.id) : base.link,
    };

    const texts =
      kind === 'video'
        ? triggers.video_challenge
        : kind === 'review'
          ? triggers.review_challenge
          : program.challenge;
    const text = renderText(passed ? texts.pass_text : texts.fail_text, values);
    return g.test
      ? `${text}\n\n_(Prueba: no se marcó ninguna actividad ni cambió la racha)_`
      : text;
  }
}
