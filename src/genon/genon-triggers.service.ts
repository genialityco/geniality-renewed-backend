import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Event } from 'src/events/schemas/event.schema';
import { Quiz } from 'src/quiz/schemas/quiz.schema';
import { UserQuizAttempt } from 'src/user-quiz-attempt/schemas/user-quiz-attempt.schema';
import { Certificate } from 'src/certificates/schemas/certificate.schema';
import { ProgressEvent } from 'src/progress-events/schemas/progress-event.schema';
import { localWeekKey } from 'src/engagement/engagement-policy';
import {
  GenOnProgram,
  GenOnTriggerKey,
  GenOnTriggersConfig,
} from './schemas/genon-program.schema';
import { GenOnEnrollment, GenOnQueued } from './schemas/genon-enrollment.schema';
import { GenOnContextService, CourseData, CourseStats } from './genon-context.service';
import { DispatchOutcome, GenOnEngineService } from './genon-engine.service';
import { withTriggerDefaults } from './genon-defaults';
import { GenOnTemplatesService } from './genon-templates.service';
import { extractVariables, renderText } from './genon-variables';
import { localDate, stepSendTime, zonedTime } from './genon-schedule';
import { daysToBridge, streakState } from './genon-streak';

const DAY_MS = 24 * 60 * 60 * 1000;
// Al activar los disparadores no se mira más atrás de esto
const FIRST_CHECK_LOOKBACK_MS = 15 * 60 * 1000;
const STREAK_LOOKBACK_DAYS = 60;
// Nota mínima por defecto de un examen (igual que el frontend)
const DEFAULT_PASS_MARK = 60;
const QUARTERS = [25, 50, 75, 100];

/** Cómo aparece cada disparador en la bitácora y en los resultados. */
export const TRIGGER_STEP: Record<GenOnTriggerKey, string> = {
  module_completed: '3.1',
  weekly_social: '3.2',
  video_challenge: '3.3',
  streak_milestone: '3.4 hito',
  streak_risk: '3.4 riesgo',
  streak_recovery: '3.4 recuperación',
  exam_reminder: 'examen',
  certificate: 'certificado',
};

// Solo para el segmento 3 (si deja de estar activo, se descartan)
const ACTIVE_ONLY: GenOnTriggerKey[] = [
  'module_completed',
  'weekly_social',
  'video_challenge',
  'streak_milestone',
  'streak_risk',
  'streak_recovery',
];

// No aplican a quien ya terminó el curso (si egresa, se descartan)
const NOT_GRADUATED: GenOnTriggerKey[] = ['exam_reminder'];

function idVariants(id: unknown): any[] {
  const raw = String(id);
  return Types.ObjectId.isValid(raw) && String(new Types.ObjectId(raw)) === raw
    ? [raw, new Types.ObjectId(raw)]
    : [raw];
}

type Candidate = Omit<GenOnQueued, 'due_at' | 'expires_at'> & {
  due_at?: Date;
  expires_at?: Date;
};

interface CourseCache {
  course: CourseData;
  stats: CourseStats;
}

/**
 * Mensajes por disparador de Gen.ON (fase 2): segmento 3 (módulo terminado,
 * comparación semanal, reto del video, racha) y los que aplican a todos
 * (recordatorio de examen, certificado). Detecta, encola por persona y
 * despacha en su franja según la prioridad del programa.
 */
@Injectable()
export class GenOnTriggersService {
  private readonly logger = new Logger(GenOnTriggersService.name);

  constructor(
    @InjectModel(GenOnProgram.name)
    private readonly programModel: Model<GenOnProgram>,
    @InjectModel(GenOnEnrollment.name)
    private readonly enrollmentModel: Model<GenOnEnrollment>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Quiz.name) private readonly quizModel: Model<Quiz>,
    @InjectModel(UserQuizAttempt.name)
    private readonly attemptModel: Model<UserQuizAttempt>,
    @InjectModel(Certificate.name)
    private readonly certificateModel: Model<Certificate>,
    @InjectModel(ProgressEvent.name)
    private readonly progressEventModel: Model<ProgressEvent>,
    private readonly context: GenOnContextService,
    private readonly engine: GenOnEngineService,
    private readonly templates: GenOnTemplatesService,
  ) {}

  /**
   * Una pasada completa del programa: segmentación y secuencias (motor) y
   * luego los disparadores. La usan el cron y "Ejecutar ahora".
   */
  async run(
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
    const budget = opts.budget ?? 40;
    const { segmentation, outcomes } = await this.engine.runProgram(program, now, opts);
    const cfg = withTriggerDefaults(program.triggers);
    const caches = new Map<string, CourseCache | null>();
    const cache = async (eventId: string) => {
      if (!caches.has(eventId)) {
        caches.set(eventId, await this.engine.loadCourseCache(program, eventId, now));
      }
      return caches.get(eventId) || null;
    };
    const detected: Record<string, number> = {};
    try {
      // Tras segmentar (una vez al día): racha, semanal, examen, certificado
      if (segmentation) Object.assign(detected, await this.detectDaily(program, cfg, now, cache));
      for (const [k, v] of Object.entries(
        await this.detectFromActivity(program, cfg, now, cache),
      )) {
        detected[k] = (detected[k] || 0) + v;
      }
    } catch (error) {
      this.logger.warn(
        `Gen.ON "${program.name}": detección de disparadores falló: ${(error as Error).message}`,
      );
    }
    const left = Math.max(0, budget - outcomes.length);
    const triggered = left
      ? await this.dispatchQueue(
          program,
          cfg,
          now,
          dryRun,
          left,
          cache,
          dryRun ? opts.planUntil : undefined,
        )
      : [];
    return { segmentation, detected, outcomes: [...outcomes, ...triggered] };
  }

  // ───────────────────────── Detección por actividad ─────────────────────────

  /** Actividades completadas desde la última revisión: módulo terminado y reto del video. */
  async detectFromActivity(
    program: GenOnProgram,
    cfg: GenOnTriggersConfig,
    now: Date,
    cache: (eventId: string) => Promise<CourseCache | null>,
  ): Promise<Record<string, number>> {
    const since =
      program.last_event_check || new Date(now.getTime() - FIRST_CHECK_LOOKBACK_MS);
    await this.programModel
      .updateOne({ _id: program._id }, { $set: { last_event_check: now } })
      .exec();
    if (!cfg.module_completed.enabled && !cfg.video_challenge.enabled) return {};

    const eventIds = (await this.engine.programEvents(program)).map((e: any) =>
      String(e._id),
    );
    if (!eventIds.length) return {};
    const done = await this.progressEventModel.collection
      .find(
        {
          type: 'activity_progress',
          to: { $gte: 100 },
          event_id: { $in: eventIds },
          at: { $gt: since, $lte: now },
        },
        { projection: { user_id: 1, event_id: 1, activity_id: 1, at: 1 } },
      )
      .toArray();

    const byPerson = new Map<string, { eventId: string; userId: string; activities: string[] }>();
    for (const d of done as any[]) {
      const key = `${d.event_id}:${d.user_id}`;
      const entry = byPerson.get(key) || {
        eventId: String(d.event_id),
        userId: String(d.user_id),
        activities: [],
      };
      entry.activities.push(String(d.activity_id));
      byPerson.set(key, entry);
    }

    const counts: Record<string, number> = {};
    for (const { eventId, userId, activities } of byPerson.values()) {
      const e = await this.enrollmentModel
        .findOne({
          program_id: String(program._id),
          event_id: eventId,
          user_id: userId,
          test: false,
          exited: false,
        })
        .exec();
      const entry = e ? await cache(eventId) : null;
      if (!e || !entry) continue;
      // Completó algo ahora: el avance real puede ser más nuevo que la caché
      const completed = new Set(entry.stats.completedByUser.get(userId) || []);
      activities.forEach((a) => completed.add(a));
      const candidates: Candidate[] = [];

      if (cfg.module_completed.enabled) {
        const modules = this.context.modulesOf(entry.course);
        const doneNow = modules
          .filter((m) => m.activityIds.every((id) => completed.has(id)))
          .map((m) => m.id);
        if (e.modules_done === null || e.modules_done === undefined) {
          // Primera vez: foto inicial sin felicitar por módulos viejos
          await this.enrollmentModel
            .updateOne({ _id: e._id }, { $set: { modules_done: doneNow } })
            .exec();
        } else {
          const fresh = doneNow.filter((id) => !e.modules_done!.includes(id));
          if (fresh.length) {
            const last = modules.filter((m) => fresh.includes(m.id)).pop()!;
            const next = modules.find((m) => m.order > last.order && !doneNow.includes(m.id));
            candidates.push({
              key: 'module_completed',
              dedupe: `module:${last.id}`,
              template_key: cfg.module_completed.template_key,
              data: {
                modulo: last.name,
                siguiente_modulo: next?.name || 'el cierre del curso',
              },
            });
            await this.enrollmentModel
              .updateOne({ _id: e._id }, { $set: { modules_done: doneNow } })
              .exec();
          }
        }
      }

      if (cfg.video_challenge.enabled) {
        const skippable = new Set(program.courses?.[eventId]?.skippable_activity_ids || []);
        for (const activityId of activities) {
          const idx = entry.course.activities.findIndex((a) => a.id === activityId);
          const next = idx >= 0 ? entry.course.activities[idx + 1] : null;
          if (
            next &&
            skippable.has(next.id) &&
            !completed.has(next.id) &&
            (entry.course.questions.get(next.id)?.eligible || 0) >=
              cfg.video_challenge.num_questions
          ) {
            candidates.push({
              key: 'video_challenge',
              dedupe: `video:${next.id}`,
              template_key: cfg.video_challenge.template_key,
              data: {
                video: next.name,
                video_id: next.id,
                min_video: this.context.minutesFor(program, eventId, next),
                url_suffix: `${entry.course.organizationId}/activitydetail/${next.id}`,
              },
            });
          }
        }
      }

      const added = await this.enqueue(program, e, candidates, now);
      for (const c of added) counts[c] = (counts[c] || 0) + 1;
    }
    return counts;
  }

  // ───────────────────────── Detección diaria ─────────────────────────

  async detectDaily(
    program: GenOnProgram,
    cfg: GenOnTriggersConfig,
    now: Date,
    cache: (eventId: string) => Promise<CourseCache | null>,
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const event of await this.engine.programEvents(program)) {
      const eventId = String(event._id);
      try {
        const entry = await cache(eventId);
        if (!entry) continue;
        const enrollments = await this.enrollmentModel
          .find({
            program_id: String(program._id),
            event_id: eventId,
            test: false,
            exited: false,
          })
          .exec();
        if (!enrollments.length) continue;
        const data = await this.loadDailyData(program, cfg, entry, enrollments, now);
        for (const e of enrollments) {
          const candidates = this.dailyCandidates(program, cfg, entry, data, e, now);
          await this.saveStreak(e, data.streaks.get(e.user_id) || null);
          const added = await this.enqueue(program, e, candidates, now);
          for (const c of added) counts[c] = (counts[c] || 0) + 1;
        }
      } catch (error) {
        this.logger.warn(
          `Gen.ON: disparadores diarios del curso ${eventId} fallaron: ${(error as Error).message}`,
        );
      }
    }
    return counts;
  }

  /** Datos del curso para los disparadores diarios (una consulta por tipo). */
  async loadDailyData(
    program: GenOnProgram,
    cfg: GenOnTriggersConfig,
    { course, stats }: CourseCache,
    enrollments: GenOnEnrollment[],
    now: Date,
  ) {
    const tz = program.timezone;
    const today = localDate(now, tz);
    const userIds = enrollments.map((e) => e.user_id);
    const eventVals = idVariants(course.eventId);

    const [quizzes, event, certified, recent] = await Promise.all([
      this.quizModel.collection
        .find(
          { eventId: { $in: eventVals }, enabled: { $ne: false } },
          { projection: { id: 1, moduleId: 1, 'config.nota': 1 } },
        )
        .toArray(),
      Types.ObjectId.isValid(course.eventId)
        ? this.eventModel.collection.findOne(
            { _id: new Types.ObjectId(course.eventId) },
            {
              projection: {
                certificate_gating_enabled: 1,
                certificate_required_activities: 1,
                certificate_required_exams: 1,
              },
            },
          )
        : null,
      this.certificateModel.collection.distinct('userId', {
        eventId: { $in: eventVals },
        status: 'COMPLETED',
        userId: { $in: userIds.flatMap(idVariants) },
      }),
      this.progressEventModel.collection
        .find(
          {
            type: 'activity_progress',
            to: { $gte: 100 },
            event_id: course.eventId,
            user_id: { $in: userIds },
            at: { $gte: new Date(now.getTime() - STREAK_LOOKBACK_DAYS * DAY_MS) },
          },
          { projection: { user_id: 1, at: 1 } },
        )
        .toArray(),
    ]);

    const quizKeys = quizzes.flatMap((q: any) => [String(q._id), q.id].filter(Boolean));
    const attempts = quizKeys.length
      ? await this.attemptModel.collection
          .find(
            { quizId: { $in: quizKeys }, userId: { $in: userIds } },
            { projection: { quizId: 1, userId: 1, score: 1 } },
          )
          .toArray()
      : [];
    // Mejor nota por persona y examen (por _id del examen)
    const quizIdByKey = new Map<string, string>();
    for (const q of quizzes as any[]) {
      quizIdByKey.set(String(q._id), String(q._id));
      if (q.id) quizIdByKey.set(String(q.id), String(q._id));
    }
    const bestScore = new Map<string, number>();
    for (const a of attempts as any[]) {
      const quizId = quizIdByKey.get(String(a.quizId));
      if (!quizId) continue;
      const key = `${a.userId}:${quizId}`;
      bestScore.set(key, Math.max(bestScore.get(key) ?? -1, Number(a.score) || 0));
    }

    // Días válidos de racha: actividades completadas y retos superados
    const validDays = new Map<string, Set<string>>();
    const addDay = (user: string, at: Date) => {
      const set = validDays.get(user) || new Set<string>();
      set.add(localDate(new Date(at), tz));
      validDays.set(user, set);
    };
    const weekly = new Map<string, number>();
    const weekStart = now.getTime() - 7 * DAY_MS;
    for (const r of recent as any[]) {
      addDay(String(r.user_id), r.at);
      if (new Date(r.at).getTime() >= weekStart) {
        weekly.set(String(r.user_id), (weekly.get(String(r.user_id)) || 0) + 1);
      }
    }
    for (const e of enrollments) {
      for (const c of e.challenges || []) if (c.passed) addDay(e.user_id, c.at);
    }
    const streaks = new Map(
      enrollments.map((e) => [
        e.user_id,
        streakState(validDays.get(e.user_id) || [], e.streak_bridged || [], today),
      ]),
    );

    return {
      today,
      quizzes: quizzes as any[],
      bestScore,
      gating: event as any,
      certified: new Set((certified as any[]).map(String)),
      weekly,
      // Cohorte de la comparación semanal: activos del curso
      cohort: enrollments.filter((e) => e.segment === 'active').map((e) => weekly.get(e.user_id) || 0),
      streaks,
      stats,
    };
  }

  private dailyCandidates(
    program: GenOnProgram,
    cfg: GenOnTriggersConfig,
    { course, stats }: CourseCache,
    data: Awaited<ReturnType<GenOnTriggersService['loadDailyData']>>,
    e: GenOnEnrollment,
    now: Date,
  ): Candidate[] {
    const candidates: Candidate[] = [];
    const completedAt = stats.completedAt.get(e.user_id) || new Map<string, Date>();
    const completed = stats.completedByUser.get(e.user_id) || new Set<string>();
    const modules = this.context.modulesOf(course);

    // Recordatorio de examen (todos los segmentos menos egresados)
    if (cfg.exam_reminder.enabled && e.segment !== 'graduated') {
      for (const quiz of data.quizzes) {
        const quizId = String(quiz._id);
        if (data.bestScore.has(`${e.user_id}:${quizId}`)) continue;
        const module = quiz.moduleId
          ? modules.find((m) => m.id === String(quiz.moduleId))
          : null;
        if (quiz.moduleId && !module) continue;
        if (!quiz.moduleId && !cfg.exam_reminder.include_final) continue;
        const ids = module ? module.activityIds : course.activities.map((a) => a.id);
        if (!ids.length || !ids.every((id) => completed.has(id))) continue;
        const last = Math.max(...ids.map((id) => completedAt.get(id)?.getTime() || 0));
        if (now.getTime() - last < cfg.exam_reminder.days_after * DAY_MS) continue;
        candidates.push({
          key: 'exam_reminder',
          dedupe: `exam:${quizId}`,
          template_key: cfg.exam_reminder.template_key,
          data: {
            modulo: module?.name || course.eventName,
            url_suffix: `${course.organizationId}/course/${course.eventId}/quiz/${quizId}`,
          },
        });
      }
    }

    // Certificado listo sin descargar (egresados)
    if (
      cfg.certificate.enabled &&
      e.segment === 'graduated' &&
      !data.certified.has(e.user_id) &&
      this.certificateUnlocked(data, e.user_id, completed.size)
    ) {
      candidates.push({
        key: 'certificate',
        dedupe: 'certificate',
        template_key: cfg.certificate.template_key,
        data: { url_suffix: `${course.organizationId}/course/${course.eventId}` },
      });
    }

    if (e.segment !== 'active') return candidates;

    // Racha académica
    const s = data.streaks.get(e.user_id);
    if (cfg.streak.enabled && s) {
      if (
        cfg.streak.milestones.includes(s.throughYesterday) &&
        s.startThroughYesterday
      ) {
        candidates.push({
          key: 'streak_milestone',
          dedupe: `milestone:${s.startThroughYesterday}:${s.throughYesterday}`,
          template_key: cfg.streak.milestone_template_key,
          data: { racha: s.throughYesterday },
          expires_at: new Date(now.getTime() + DAY_MS),
        });
      }
      const week = localWeekKey(now, program.timezone);
      const riskAt = zonedTime(data.today, cfg.streak.risk_time, program.timezone);
      if (
        cfg.streak.risk_enabled &&
        s.throughYesterday >= cfg.streak.risk_min &&
        !s.activeToday &&
        e.streak_risk_week !== week &&
        riskAt.getTime() > now.getTime()
      ) {
        candidates.push({
          key: 'streak_risk',
          dedupe: `risk:${data.today}`,
          template_key: cfg.streak.risk_template_key,
          data: { racha: s.throughYesterday },
          due_at: riskAt,
          expires_at: zonedTime(data.today, '23:59', program.timezone),
          unless_active_today: true,
        });
      }
      if (
        cfg.streak.recovery_enabled &&
        s.broken &&
        s.broken.count >= cfg.streak.recovery_min
      ) {
        const review = this.context.reviewActivityFor(
          course,
          completedAt,
          program.challenge?.num_questions || 3,
        );
        if (review) {
          candidates.push({
            key: 'streak_recovery',
            dedupe: `recovery:${s.broken.lastDay}`,
            template_key: cfg.streak.recovery_template_key,
            data: { ultima_actividad: review.name, racha: s.broken.count },
            expires_at: new Date(now.getTime() + DAY_MS),
          });
        }
      }
    }

    // Comparación social semanal
    const weekday = new Date(`${data.today}T12:00:00Z`).getUTCDay();
    if (
      cfg.weekly_social.enabled &&
      weekday === cfg.weekly_social.weekday &&
      data.cohort.length >= (program.social_min || 0)
    ) {
      const mine = data.weekly.get(e.user_id) || 0;
      if (mine > 0) {
        const below = data.cohort.filter((n) => n < mine).length;
        const percentil = Math.round((below / data.cohort.length) * 100);
        const week = localWeekKey(now, program.timezone);
        if (percentil >= 50) {
          candidates.push({
            key: 'weekly_social',
            dedupe: `weekly:${week}`,
            template_key: cfg.weekly_social.above_template_key,
            data: { percentil },
          });
        } else {
          const hito = QUARTERS.find((q) => q > (e.progress || 0)) || 100;
          const needed = Math.ceil((hito / 100) * course.activities.length);
          candidates.push({
            key: 'weekly_social',
            dedupe: `weekly:${week}`,
            template_key: cfg.weekly_social.below_template_key,
            data: {
              actividades_semana: mine,
              hito: hito === 100 ? 'el final del curso' : `el ${hito} % del curso`,
              faltan_hito: Math.max(1, needed - completed.size),
            },
          });
        }
      }
    }
    return candidates;
  }

  /** Misma regla que el frontend (getCertificateGate): sin reglas, sigue bloqueado. */
  private certificateUnlocked(
    data: { gating: any; quizzes: any[]; bestScore: Map<string, number> },
    userId: string,
    completedCount: number,
  ): boolean {
    const g = data.gating;
    if (!g?.certificate_gating_enabled) return false;
    if (
      g.certificate_required_activities != null &&
      completedCount < g.certificate_required_activities
    ) {
      return false;
    }
    if (g.certificate_required_exams != null) {
      const passed = data.quizzes.filter((q) => {
        const best = data.bestScore.get(`${userId}:${String(q._id)}`);
        return best !== undefined && best >= (q.config?.nota ?? DEFAULT_PASS_MARK);
      }).length;
      if (passed < g.certificate_required_exams) return false;
    }
    return true;
  }

  private async saveStreak(
    e: GenOnEnrollment,
    s: ReturnType<typeof streakState> | null,
  ) {
    if (!s) return;
    const best = Math.max(e.streak?.best || 0, s.current);
    await this.enrollmentModel
      .updateOne(
        { _id: e._id },
        {
          $set: {
            streak: {
              current: s.current,
              best,
              last_day: s.lastValidDay,
              updated_on: new Date().toISOString().slice(0, 10),
            },
          },
        },
      )
      .exec();
  }

  // ───────────────────────── Cola ─────────────────────────

  /** Encola los disparos nuevos (no repetidos). Devuelve las claves encoladas. */
  async enqueue(
    program: GenOnProgram,
    e: GenOnEnrollment,
    candidates: Candidate[],
    now: Date,
  ): Promise<GenOnTriggerKey[]> {
    const fired = new Set(e.fired || []);
    const fresh = candidates.filter((c) => !fired.has(c.dedupe));
    if (!fresh.length) return [];
    const queued: GenOnQueued[] = fresh.map((c) => {
      const due =
        c.due_at ||
        stepSendTime({
          segmentSince: now,
          day: 0,
          slot: e.slot || program.send_slots?.[0] || '12:00',
          timeZone: program.timezone,
          blockedWeekdays: program.blocked_weekdays,
          now,
        });
      return {
        ...c,
        due_at: due,
        expires_at: c.expires_at || new Date(due.getTime() + 2 * DAY_MS),
      };
    });
    await this.enrollmentModel
      .updateOne(
        { _id: e._id },
        {
          $push: { queue: { $each: queued } },
          $addToSet: { fired: { $each: queued.map((q) => q.dedupe) } },
        },
      )
      .exec();
    return queued.map((q) => q.key);
  }

  /**
   * Envía, por persona, el disparo pendiente de mayor prioridad (uno por
   * ejecución; el tope semanal frena los demás, como pide el documento).
   */
  async dispatchQueue(
    program: GenOnProgram,
    cfg: GenOnTriggersConfig,
    now: Date,
    dryRun: boolean,
    budget: number,
    cache: (eventId: string) => Promise<CourseCache | null>,
    planUntil?: Date,
  ): Promise<DispatchOutcome[]> {
    const until = planUntil && planUntil > now ? planUntil : now;
    const due = await this.enrollmentModel
      .find({
        program_id: String(program._id),
        test: false,
        exited: false,
        'queue.due_at': { $lte: until },
      })
      .limit(budget)
      .exec();
    const priority = (key: GenOnTriggerKey) => {
      const i = cfg.priority.indexOf(key);
      return i < 0 ? 99 : i;
    };

    const outcomes: DispatchOutcome[] = [];
    for (const e of due) {
      const live = (e.queue || []).filter(
        (q) =>
          new Date(q.expires_at).getTime() > now.getTime() &&
          (!ACTIVE_ONLY.includes(q.key) || e.segment === 'active') &&
          (!NOT_GRADUATED.includes(q.key) || e.segment !== 'graduated'),
      );
      const ready = live
        .filter((q) => new Date(q.due_at).getTime() <= until.getTime())
        .sort((a, b) => priority(a.key) - priority(b.key));
      const item = ready[0];
      if (!item) {
        await this.setQueue(e, live);
        continue;
      }
      try {
        // Lo planeado por adelantado queda registrado a la hora en que saldría
        const at = new Date(Math.max(now.getTime(), new Date(item.due_at).getTime()));
        const outcome = await this.sendQueued(program, e, item, at, dryRun, cache);
        outcomes.push(outcome);
        let rest = live.filter((q) => q !== item);
        if (outcome.result === 'capped') {
          // Se reintenta en la franja del día siguiente mientras no venza
          rest = [...rest, { ...item, due_at: this.nextSlot(program, e, now) }];
        }
        await this.setQueue(e, rest);
        if (item.key === 'streak_risk' && outcome.result !== 'capped') {
          await this.enrollmentModel
            .updateOne(
              { _id: e._id },
              { $set: { streak_risk_week: localWeekKey(now, program.timezone) } },
            )
            .exec();
        }
      } catch (error) {
        const reason = (error as Error).message;
        await this.setQueue(e, live.filter((q) => q !== item));
        outcomes.push(this.outcome(e, item, 'error', reason));
      }
    }
    return outcomes;
  }

  private async sendQueued(
    program: GenOnProgram,
    e: GenOnEnrollment,
    item: GenOnQueued,
    now: Date,
    dryRun: boolean,
    cache: (eventId: string) => Promise<CourseCache | null>,
  ): Promise<DispatchOutcome> {
    if (item.unless_active_today && (await this.activeToday(program, e, now))) {
      return this.outcome(e, item, 'skipped', 'ya tuvo actividad hoy');
    }
    const entry = await cache(e.event_id);
    if (!entry) return this.outcome(e, item, 'skipped', 'curso no encontrado');
    const person = await this.engine.resolvePerson(e.organization_id, e.user_id);
    if (!person.phone || !person.consent) {
      return this.outcome(
        e,
        item,
        'skipped',
        !person.phone ? 'sin teléfono' : 'sin consentimiento',
      );
    }
    const ctx = this.context.forPerson(
      program,
      entry.course,
      entry.stats,
      { userId: e.user_id, fullName: person.name, email: person.email, progress: e.progress },
      e.segment,
    );
    const { url_suffix, video_id, ...values } = item.data || {};
    const delivery = await this.engine.deliverTemplate(program, e, person, {
      templateKey: item.template_key,
      values: { ...ctx.values, ...values },
      urlSuffix: url_suffix || ctx.urlSuffix,
      dedupeKey: `genon:${String(e._id)}:${item.dedupe}:${localDate(now, program.timezone)}`,
      segment: e.segment,
      step: TRIGGER_STEP[item.key],
      holdout: e.holdout,
      dryRun,
      actionData: video_id ? { video_id } : undefined,
      at: now,
    });
    if (delivery.result === 'not_approved' || delivery.result === 'missing_data') {
      return this.outcome(e, item, 'skipped', delivery.reason);
    }
    return this.outcome(e, item, delivery.result);
  }

  /** ¿Completó una actividad o superó un reto hoy? (racha en riesgo) */
  private async activeToday(program: GenOnProgram, e: GenOnEnrollment, now: Date) {
    const today = localDate(now, program.timezone);
    const start = zonedTime(today, '00:00', program.timezone);
    if ((e.challenges || []).some((c) => c.passed && new Date(c.at) >= start)) return true;
    return Boolean(
      await this.progressEventModel.collection.findOne({
        type: 'activity_progress',
        to: { $gte: 100 },
        event_id: e.event_id,
        user_id: e.user_id,
        at: { $gte: start },
      }),
    );
  }

  private nextSlot(program: GenOnProgram, e: GenOnEnrollment, now: Date): Date {
    return stepSendTime({
      segmentSince: new Date(now.getTime() + DAY_MS),
      day: 0,
      slot: e.slot || program.send_slots?.[0] || '12:00',
      timeZone: program.timezone,
      blockedWeekdays: program.blocked_weekdays,
      now,
    });
  }

  private async setQueue(e: GenOnEnrollment, queue: GenOnQueued[]) {
    await this.enrollmentModel.updateOne({ _id: e._id }, { $set: { queue } }).exec();
  }

  private outcome(
    e: GenOnEnrollment,
    item: GenOnQueued,
    result: DispatchOutcome['result'],
    reason?: string,
  ): DispatchOutcome {
    return {
      enrollment_id: String(e._id),
      user_id: e.user_id,
      event_id: e.event_id,
      segment: e.segment,
      step: TRIGGER_STEP[item.key],
      result,
      ...(reason ? { reason } : {}),
    };
  }

  // ───────────────────────── Racha (para la conversación) ─────────────────────────

  /**
   * Tras superar un reto: si la racha estaba cortada dentro de la ventana de
   * recuperación, puentea los días sin estudio. Devuelve la racha actual.
   */
  async applyChallengeToStreak(
    program: GenOnProgram,
    e: GenOnEnrollment,
    now: Date,
  ): Promise<number> {
    const cfg = withTriggerDefaults(program.triggers);
    const tz = program.timezone;
    const today = localDate(now, tz);
    const recent = await this.progressEventModel.collection
      .find(
        {
          type: 'activity_progress',
          to: { $gte: 100 },
          event_id: e.event_id,
          user_id: e.user_id,
          at: { $gte: new Date(now.getTime() - STREAK_LOOKBACK_DAYS * DAY_MS) },
        },
        { projection: { at: 1 } },
      )
      .toArray();
    const valid = new Set(recent.map((r: any) => localDate(new Date(r.at), tz)));
    for (const c of e.challenges || []) {
      if (c.passed) valid.add(localDate(new Date(c.at), tz));
    }
    // El reto de hoy ya cuenta
    valid.add(today);

    const bridged = new Set(e.streak_bridged || []);
    const gap = daysToBridge(
      [...valid].filter((d) => d !== today),
      bridged,
      today,
      cfg.streak.recovery_window_days,
    );
    if (gap.length) {
      gap.forEach((d) => bridged.add(d));
      await this.enrollmentModel
        .updateOne({ _id: e._id }, { $addToSet: { streak_bridged: { $each: gap } } })
        .exec();
    }
    const s = streakState(valid, bridged, today);
    const best = Math.max(e.streak?.best || 0, s.current);
    await this.enrollmentModel
      .updateOne(
        { _id: e._id },
        {
          $set: {
            streak: { current: s.current, best, last_day: today, updated_on: today },
          },
        },
      )
      .exec();
    return s.current;
  }

  // ───────────────────────── Pruebas ─────────────────────────

  /**
   * Qué dispararía hoy para una persona (sin encolar nada): su racha, los
   * disparadores diarios que cumpliría y lo que ya tiene en cola.
   */
  async simulateForUser(program: GenOnProgram, userId: string, eventId: string) {
    const now = new Date();
    const cfg = withTriggerDefaults(program.triggers);
    const sim = await this.engine.simulate(program, userId, eventId);
    const entry = await this.engine.loadCourseCache(program, eventId, now);
    if (!entry) throw new NotFoundException('Curso no encontrado');
    const all = await this.enrollmentModel
      .find({ program_id: String(program._id), event_id: eventId, test: false })
      .exec();
    const saved = all.find((e) => e.user_id === userId);
    const person = (saved ||
      new this.enrollmentModel({
        program_id: String(program._id),
        event_id: eventId,
        user_id: userId,
        organization_id: entry.course.organizationId,
        segment: sim.segment,
        segment_since: now,
        progress: sim.progress,
        test: false,
      })) as GenOnEnrollment;
    // Con el segmento de hoy, aunque la segmentación guardada sea de ayer
    person.segment = sim.segment;
    const enrollments = saved ? all : [...all, person];
    const data = await this.loadDailyData(program, cfg, entry, enrollments, now);
    const candidates = this.dailyCandidates(program, cfg, entry, data, person, now);
    const streak = data.streaks.get(userId) || null;
    return {
      segment: sim.segment,
      streak,
      weekly_activities: data.weekly.get(userId) || 0,
      candidates: candidates.map((c) => ({
        key: c.key,
        step: TRIGGER_STEP[c.key],
        template_key: c.template_key,
        already_sent: (saved?.fired || []).includes(c.dedupe),
        data: c.data,
      })),
      queue: (saved?.queue || []).map((q) => ({
        key: q.key,
        step: TRIGGER_STEP[q.key],
        due_at: q.due_at,
        expires_at: q.expires_at,
      })),
    };
  }

  /**
   * Mensaje de un disparador con los datos reales de la persona; si hoy no
   * se cumple, con datos de ejemplo para poder revisar el texto.
   */
  async buildTriggerMessage(
    program: GenOnProgram,
    userId: string,
    eventId: string,
    key: GenOnTriggerKey,
  ) {
    const now = new Date();
    const cfg = withTriggerDefaults(program.triggers);
    const { course, stats, row } = await this.engine.loadForUser(program, userId, eventId, now);
    const person = await this.engine.resolvePerson(course.organizationId, userId);
    const sim = await this.simulateForUser(program, userId, eventId);
    const ctx = this.context.forPerson(
      program,
      course,
      stats,
      { userId, fullName: person.name, email: person.email, progress: row.course_progress },
      sim.segment,
    );
    const real = sim.candidates.find((c) => c.key === key);
    const sample = !real;
    let data: Record<string, any> = real?.data || {};
    let templateKey = real?.template_key || this.templateFor(cfg, key);

    if (!real) {
      const modules = this.context.modulesOf(course);
      const completedAt = stats.completedAt.get(userId);
      const skippable = program.courses?.[eventId]?.skippable_activity_ids || [];
      const video = course.activities.find((a) => skippable.includes(a.id)) || null;
      const review = this.context.reviewActivityFor(
        course,
        completedAt,
        program.challenge?.num_questions || 3,
      );
      data = {
        modulo: modules[0]?.name || course.eventName,
        siguiente_modulo: modules[1]?.name || 'el cierre del curso',
        percentil: 70,
        actividades_semana: 2,
        hito: 'el 50 % del curso',
        faltan_hito: 1,
        racha: sim.streak?.current || 3,
        ultima_actividad: review?.name || course.activities[0]?.name || 'tu última actividad',
        ...(key === 'video_challenge' && video
          ? {
              video: video.name,
              video_id: video.id,
              min_video: this.context.minutesFor(program, eventId, video),
              url_suffix: `${course.organizationId}/activitydetail/${video.id}`,
            }
          : {}),
      };
      if (key === 'video_challenge' && !video) {
        throw new BadRequestException(
          'Marca al menos un video como saltable en "Cursos y retos" para probar el reto del video.',
        );
      }
      if (key === 'weekly_social') templateKey = cfg.weekly_social.above_template_key;
    }
    const { url_suffix, video_id, ...overrides } = data;
    return {
      sample,
      segment: sim.segment,
      progress: row.course_progress,
      organizationId: course.organizationId,
      templateKey,
      values: { ...ctx.values, ...overrides },
      urlSuffix: url_suffix || ctx.urlSuffix,
      actionData: video_id ? { video_id } : undefined,
    };
  }

  async previewTrigger(
    program: GenOnProgram,
    userId: string,
    eventId: string,
    key: GenOnTriggerKey,
  ) {
    const msg = await this.buildTriggerMessage(program, userId, eventId, key);
    const template = await this.templates.byKey(msg.templateKey);
    if (!template) throw new NotFoundException(`No existe la plantilla "${msg.templateKey}"`);
    const body = template.approved?.body || template.body;
    const buttons = template.approved?.buttons || template.buttons;
    return {
      step: TRIGGER_STEP[key],
      sample: msg.sample,
      template_key: template.key,
      template_status: template.meta_status,
      approved: Boolean(template.approved),
      text: renderText(body, msg.values),
      buttons: buttons.map((b) => b.text),
      missing: extractVariables(body).filter(
        (v) => msg.values[v] === null || msg.values[v] === undefined || msg.values[v] === '',
      ),
    };
  }

  async sendTriggerTest(
    program: GenOnProgram,
    userId: string,
    eventId: string,
    key: GenOnTriggerKey,
    to: string,
  ) {
    const msg = await this.buildTriggerMessage(program, userId, eventId, key);
    const result = await this.engine.sendTestTemplate(program, {
      userId,
      eventId,
      organizationId: msg.organizationId,
      // El reto de los botones (racha, video) se arma como en un activo
      segment: msg.segment,
      progress: msg.progress,
      lastStepKey: null,
      lastStepDay: null,
      templateKey: msg.templateKey,
      values: msg.values,
      urlSuffix: msg.urlSuffix,
      to,
      actionData: msg.actionData,
    });
    return { ...result, sample: msg.sample };
  }

  private templateFor(cfg: GenOnTriggersConfig, key: GenOnTriggerKey): string {
    switch (key) {
      case 'module_completed':
        return cfg.module_completed.template_key;
      case 'weekly_social':
        return cfg.weekly_social.above_template_key;
      case 'video_challenge':
        return cfg.video_challenge.template_key;
      case 'streak_milestone':
        return cfg.streak.milestone_template_key;
      case 'streak_risk':
        return cfg.streak.risk_template_key;
      case 'streak_recovery':
        return cfg.streak.recovery_template_key;
      case 'exam_reminder':
        return cfg.exam_reminder.template_key;
      case 'certificate':
        return cfg.certificate.template_key;
    }
  }
}
