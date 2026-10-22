import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Event } from 'src/events/schemas/event.schema';
import { Activity } from 'src/activities/schemas/activity.schema';
import { ActivityAttendee } from 'src/activity-attendee/schemas/activity-attendee.schema';
import { ActivityQuestion } from 'src/ai-evaluations/schemas/activity-question.schema';
import { TranscriptSegment } from 'src/transcript-segments/schemas/transcript-segment.schema';
import { ProgressEvent } from 'src/progress-events/schemas/progress-event.schema';
import { activityLink } from 'src/ai-evaluations/practice-format';
import {
  GenOnMetric,
  GenOnProgram,
  GenOnSegment,
} from './schemas/genon-program.schema';

const DAY_MS = 24 * 60 * 60 * 1000;

function idVariants(id: unknown): any[] {
  const raw = String(id);
  return Types.ObjectId.isValid(raw) && String(new Types.ObjectId(raw)) === raw
    ? [raw, new Types.ObjectId(raw)]
    : [raw];
}

const baseUrl = () =>
  (process.env.WHATSAPP_REMINDER_BASE_URL || 'https://app.geniality.com.co').replace(
    /\/+$/,
    '',
  );

export interface CourseActivity {
  id: string;
  name: string;
  module_id: string | null;
  module_name: string | null;
  module_order: number | null;
  /** Duración aproximada del video (fin del último segmento de transcripción) */
  video_seconds: number | null;
}

export interface CourseData {
  eventId: string;
  eventName: string;
  organizationId: string;
  /** En el orden del curso: módulo, luego creación */
  activities: CourseActivity[];
  /** Por actividad: preguntas válidas para reto y su tema más frecuente */
  questions: Map<string, { eligible: number; topic: string | null }>;
}

export interface CourseStats {
  graduated: number;
  advanced7d: number;
  advanced14d: number;
  completedByUser: Map<string, Set<string>>;
  /** Cuándo completó cada actividad (última actualización al 100 %) */
  completedAt: Map<string, Map<string, Date>>;
  /** Por módulo: quiénes llegaron (completaron algo ahí o después) y cuántos terminaron */
  fromModule: Map<string, { base: number; graduated: number }>;
}

/** Datos del inscrito para armar sus variables. */
export interface PersonInput {
  userId: string;
  fullName: string;
  email: string;
  progress: number;
}

export interface PersonContext {
  values: Record<string, string | number | null>;
  metrics: Record<GenOnMetric, number>;
  pendingActivity: CourseActivity | null;
  challengeActivity: CourseActivity | null;
  /** Sufijo del botón de enlace (después de /organization/) */
  urlSuffix: string;
}

/**
 * Pregunta apta para un reto por WhatsApp (se califica sin IA):
 * verdadero/falso, opción única (botones hasta 3 opciones, lista hasta 10)
 * o selección múltiple (responde con letras).
 */
export function isChallengeQuestion(q: {
  type: string;
  options?: { correct: boolean }[];
}): boolean {
  if (q.type === 'true_false') return true;
  const options = q.options || [];
  const correct = options.filter((o) => o.correct).length;
  if (options.length < 2 || options.length > 10) return false;
  if (q.type === 'single_choice') return correct === 1;
  if (q.type === 'multiple_choice') return correct >= 1 && correct < options.length;
  return false;
}

/**
 * Datos de los cursos y de cada inscrito para Gen.ON: actividades en orden,
 * datos sociales del curso y las variables de cada mensaje. Todo sale de la
 * base de datos (nunca de texto generado).
 */
@Injectable()
export class GenOnContextService {
  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Activity.name) private readonly activityModel: Model<Activity>,
    @InjectModel('Module') private readonly moduleModel: Model<any>,
    @InjectModel(ActivityAttendee.name)
    private readonly attendeeModel: Model<ActivityAttendee>,
    @InjectModel(ActivityQuestion.name)
    private readonly questionModel: Model<ActivityQuestion>,
    @InjectModel(TranscriptSegment.name)
    private readonly segmentModel: Model<TranscriptSegment>,
    @InjectModel(ProgressEvent.name)
    private readonly progressEventModel: Model<ProgressEvent>,
  ) {}

  async loadCourse(eventId: string): Promise<CourseData | null> {
    if (!Types.ObjectId.isValid(eventId)) return null;
    const event: any = await this.eventModel.collection.findOne(
      { _id: new Types.ObjectId(eventId) },
      { projection: { name: 1, organizer_id: 1 } },
    );
    if (!event) return null;

    const eventVals = idVariants(eventId);
    const [activities, modules] = await Promise.all([
      this.activityModel.collection
        .find(
          { event_id: { $in: eventVals } },
          { projection: { name: 1, module_id: 1, createdAt: 1 } },
        )
        .toArray(),
      this.moduleModel.collection
        .find(
          { event_id: { $in: eventVals } },
          { projection: { module_name: 1, order: 1 } },
        )
        .toArray(),
    ]);
    const moduleById = new Map(modules.map((m: any) => [String(m._id), m]));
    const activityIds = activities.map((a: any) => a._id);

    const [segments, questions] = await Promise.all([
      activityIds.length
        ? this.segmentModel.collection
            .aggregate([
              { $match: { activity_id: { $in: activityIds } } },
              { $group: { _id: '$activity_id', end: { $max: '$endTime' } } },
            ])
            .toArray()
        : Promise.resolve([] as any[]),
      activityIds.length
        ? this.questionModel.collection
            .find(
              { activity_id: { $in: activityIds }, enabled: true },
              { projection: { activity_id: 1, type: 1, options: 1, topic: 1 } },
            )
            .toArray()
        : Promise.resolve([] as any[]),
    ]);
    const secondsById = new Map(
      segments.map((s: any) => [String(s._id), Number(s.end) || null]),
    );

    const questionInfo = new Map<string, { eligible: number; topic: string | null }>();
    const topicCounts = new Map<string, Map<string, number>>();
    for (const q of questions as any[]) {
      const id = String(q.activity_id);
      const info = questionInfo.get(id) || { eligible: 0, topic: null };
      if (isChallengeQuestion(q)) info.eligible++;
      questionInfo.set(id, info);
      const topic = String(q.topic || '').trim();
      if (topic) {
        const counts = topicCounts.get(id) || new Map<string, number>();
        counts.set(topic, (counts.get(topic) || 0) + 1);
        topicCounts.set(id, counts);
      }
    }
    for (const [id, counts] of topicCounts) {
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const info = questionInfo.get(id);
      if (info && top) info.topic = top[0];
    }

    const ordered = activities
      .map((a: any) => {
        const mod = a.module_id ? moduleById.get(String(a.module_id)) : null;
        return {
          id: String(a._id),
          name: a.name || 'Actividad',
          module_id: a.module_id ? String(a.module_id) : null,
          module_name: mod?.module_name ?? null,
          module_order: typeof mod?.order === 'number' ? mod.order : null,
          video_seconds: secondsById.get(String(a._id)) ?? null,
          created: a.createdAt ? new Date(a.createdAt).getTime() : 0,
        };
      })
      // Mismo orden que las métricas del curso: módulo, creación, nombre
      .sort(
        (a, b) =>
          (a.module_order ?? Number.MAX_SAFE_INTEGER) -
            (b.module_order ?? Number.MAX_SAFE_INTEGER) ||
          a.created - b.created ||
          a.name.localeCompare(b.name),
      )
      .map(({ created, ...rest }) => rest);

    return {
      eventId,
      eventName: event.name || 'tu curso',
      organizationId: String(event.organizer_id),
      activities: ordered,
      questions: questionInfo,
    };
  }

  /** Datos sociales del curso y actividades completadas por cada inscrito. */
  async loadStats(
    course: CourseData,
    progressByUser: Map<string, number>,
    now: Date,
  ): Promise<CourseStats> {
    const activityVals = course.activities.flatMap((a) => idVariants(a.id));
    const [completed, recent] = await Promise.all([
      activityVals.length
        ? this.attendeeModel.collection
            .aggregate([
              {
                $match: {
                  activity_id: { $in: activityVals },
                  progress: { $gte: 100 },
                },
              },
              {
                $group: {
                  _id: {
                    user: { $toString: '$user_id' },
                    activity: { $toString: '$activity_id' },
                  },
                  at: { $max: '$updatedAt' },
                },
              },
            ])
            .toArray()
        : Promise.resolve([] as any[]),
      this.progressEventModel.collection
        .aggregate([
          {
            $match: {
              event_id: course.eventId,
              type: 'activity_progress',
              at: { $gte: new Date(now.getTime() - 14 * DAY_MS) },
            },
          },
          { $group: { _id: '$user_id', last: { $max: '$at' } } },
        ])
        .toArray(),
    ]);

    const completedByUser = new Map<string, Set<string>>();
    const completedAt = new Map<string, Map<string, Date>>();
    for (const r of completed as any[]) {
      const user = String(r._id.user);
      const activity = String(r._id.activity);
      if (!completedByUser.has(user)) completedByUser.set(user, new Set());
      completedByUser.get(user)!.add(activity);
      if (!completedAt.has(user)) completedAt.set(user, new Map());
      if (r.at) completedAt.get(user)!.set(activity, new Date(r.at));
    }

    const since7 = now.getTime() - 7 * DAY_MS;
    const advanced7d = (recent as any[]).filter(
      (r) => new Date(r.last).getTime() >= since7,
    ).length;

    // "Llegaron hasta el módulo M": completaron algo en M o en uno posterior
    const moduleOrder = new Map<string, number>();
    for (const a of course.activities) {
      if (a.module_id && a.module_order !== null) {
        moduleOrder.set(a.module_id, a.module_order);
      }
    }
    const orderByActivity = new Map(
      course.activities.map((a) => [a.id, a.module_order]),
    );
    const fromModule = new Map<string, { base: number; graduated: number }>();
    for (const [userId, set] of completedByUser) {
      let reached = -Infinity;
      for (const id of set) {
        const order = orderByActivity.get(id);
        if (order !== null && order !== undefined && order > reached) {
          reached = order;
        }
      }
      if (reached === -Infinity) continue;
      const graduated = (progressByUser.get(userId) || 0) >= 100;
      for (const [moduleId, order] of moduleOrder) {
        if (order > reached) continue;
        const entry = fromModule.get(moduleId) || { base: 0, graduated: 0 };
        entry.base++;
        if (graduated) entry.graduated++;
        fromModule.set(moduleId, entry);
      }
    }

    let graduated = 0;
    for (const p of progressByUser.values()) if (p >= 100) graduated++;

    return {
      graduated,
      advanced7d,
      advanced14d: recent.length,
      completedByUser,
      completedAt,
      fromModule,
    };
  }

  /** Minutos estimados de una actividad: configurados, del video o por defecto. */
  minutesFor(program: GenOnProgram, eventId: string, a: CourseActivity | null): number {
    if (!a) return program.default_activity_minutes || 15;
    const configured = Number(program.courses?.[eventId]?.activity_minutes?.[a.id]);
    if (configured > 0) return Math.round(configured);
    if (a.video_seconds && a.video_seconds > 0) {
      return Math.max(1, Math.round(a.video_seconds / 60));
    }
    return program.default_activity_minutes || 15;
  }

  /** Módulos del curso en orden, con sus actividades. */
  modulesOf(course: CourseData): {
    id: string;
    name: string;
    order: number;
    activityIds: string[];
  }[] {
    const byId = new Map<string, { id: string; name: string; order: number; activityIds: string[] }>();
    for (const a of course.activities) {
      if (!a.module_id) continue;
      const m = byId.get(a.module_id) || {
        id: a.module_id,
        name: a.module_name || 'el módulo',
        order: a.module_order ?? Number.MAX_SAFE_INTEGER,
        activityIds: [],
      };
      m.activityIds.push(a.id);
      byId.set(a.module_id, m);
    }
    return [...byId.values()].sort((a, b) => a.order - b.order);
  }

  /**
   * Actividad del reto de repaso: la última que estudió (completó) con
   * preguntas suficientes en el banco. No necesita estar habilitada para
   * reto porque no cambia el avance.
   */
  reviewActivityFor(
    course: CourseData,
    completedAt: Map<string, Date> | undefined,
    needed: number,
  ): CourseActivity | null {
    const done = [...(completedAt?.entries() || [])].sort(
      (a, b) => b[1].getTime() - a[1].getTime(),
    );
    for (const [activityId] of done) {
      const a = course.activities.find((x) => x.id === activityId);
      if (a && (course.questions.get(a.id)?.eligible || 0) >= needed) return a;
    }
    return null;
  }

  /**
   * Actividad del reto: la primera del curso (abandono) o la pendiente
   * (inactivos), si está habilitada para reto y tiene preguntas suficientes;
   * si no, la primera habilitada que no haya completado.
   */
  challengeActivityFor(
    program: GenOnProgram,
    course: CourseData,
    segment: GenOnSegment,
    completed: Set<string>,
  ): CourseActivity | null {
    const enabled = new Set(
      program.courses?.[course.eventId]?.challenge_activity_ids || [],
    );
    const needed = Math.max(1, program.challenge?.num_questions || 3);
    const ok = (a: CourseActivity | undefined | null) =>
      Boolean(
        a &&
          enabled.has(a.id) &&
          !completed.has(a.id) &&
          (course.questions.get(a.id)?.eligible || 0) >= needed,
      );
    const preferred =
      segment === 'abandon'
        ? course.activities[0]
        : course.activities.find((a) => !completed.has(a.id));
    if (ok(preferred)) return preferred!;
    return course.activities.find((a) => ok(a)) || null;
  }

  forPerson(
    program: GenOnProgram,
    course: CourseData,
    stats: CourseStats,
    person: PersonInput,
    segment: GenOnSegment,
  ): PersonContext {
    const completed = stats.completedByUser.get(person.userId) || new Set<string>();
    const pending = course.activities.find((a) => !completed.has(a.id)) || null;
    const challenge = this.challengeActivityFor(program, course, segment, completed);
    const fromHere = pending?.module_id
      ? stats.fromModule.get(pending.module_id)
      : undefined;
    const pct =
      fromHere && fromHere.base > 0
        ? Math.round((fromHere.graduated / fromHere.base) * 100)
        : 0;
    const topic = challenge
      ? course.questions.get(challenge.id)?.topic || challenge.name
      : null;

    const link = pending
      ? activityLink(course.organizationId, pending.id)
      : `${baseUrl()}/organization/${course.organizationId}/course/${course.eventId}`;
    const urlSuffix = pending
      ? `${course.organizationId}/activitydetail/${pending.id}`
      : `${course.organizationId}/course/${course.eventId}`;

    const metrics: Record<GenOnMetric, number> = {
      n_egresados: stats.graduated,
      n_activos_semana: stats.advanced7d,
      n_avanzaron: stats.advanced14d,
      pct_terminaron_desde_aqui: pct,
      base_desde_aqui: fromHere?.base || 0,
      avance: Math.round(person.progress || 0),
    };

    return {
      metrics,
      pendingActivity: pending,
      challengeActivity: challenge,
      urlSuffix,
      values: {
        nombre: (person.fullName || 'estudiante').trim().split(/\s+/)[0],
        correo: person.email || null,
        curso: course.eventName,
        avance: metrics.avance,
        actividad_1: course.activities[0]?.name ?? null,
        actividad_2: course.activities[1]?.name ?? null,
        actividad_pendiente: pending?.name ?? null,
        modulo_actual: pending?.module_name ?? null,
        actividades_restantes: Math.max(
          0,
          course.activities.length - completed.size,
        ),
        min_actividad: this.minutesFor(program, course.eventId, pending),
        actividad_reto: challenge?.name ?? null,
        tema_actividad: topic,
        num_preguntas: program.challenge?.num_questions || 3,
        n_egresados: metrics.n_egresados,
        n_activos_semana: metrics.n_activos_semana,
        n_avanzaron: metrics.n_avanzaron,
        pct_terminaron_desde_aqui: pct,
        link,
      },
    };
  }
}
