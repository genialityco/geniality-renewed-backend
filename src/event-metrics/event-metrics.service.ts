import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Event } from '../events/schemas/event.schema';
import { CourseAttendee } from '../course-attendee/schemas/course-attendee.schema';
import { ActivityAttendee } from '../activity-attendee/schemas/activity-attendee.schema';
import { Activity } from '../activities/schemas/activity.schema';
import { Module as CourseModule } from '../modules/schemas/module.schema';
import { UserActivity } from '../user-activity/schemas/user-activity.schema';
import { Quiz, QuizDocument } from '../quiz/schemas/quiz.schema';
import { UserQuizAttempt } from '../user-quiz-attempt/schemas/user-quiz-attempt.schema';
import { Certificate } from '../certificates/schemas/certificate.schema';
import { User } from '../users/schemas/user.schema';
import { OrganizationUser } from '../organization-users/schemas/organization-user.schema';
import admin from '../firebase-admin';

export interface ActivityMetrics {
  activityId: string;
  name: string;
  moduleId: string | null;
  moduleName: string | null;
  moduleOrder: number | null;
  attendees: number;
  completed: number;
  avgProgress: number;
  totalTimeMs: number;
  usersWithTime: number;
}

/** Métricas de UN examen del curso: el general o el de un módulo. */
export interface QuizMetrics {
  quizId: string;
  /** null = examen general del curso */
  moduleId: string | null;
  moduleName: string | null;
  moduleOrder: number | null;
  enabled: boolean;
  passingScore: number | null;
  totalAttempts: number;
  uniqueUsers: number;
  graded: number;
  pending: number;
  review: number;
  avgBestScore: number | null;
  passedUsers: number | null;
  gradedUsers: number;
}

export interface EventMetrics {
  event: {
    id: string;
    name: string;
    datetime_from: Date;
    datetime_to: Date;
  };
  enrollment: {
    total: number;
    completed: number;
    inProgress: number;
    notStarted: number;
    avgProgress: number;
    byMonth: { month: string; count: number }[];
  };
  time: {
    totalMs: number;
    usersWithTime: number;
    avgPerUserMs: number;
  };
  activities: ActivityMetrics[];
  /**
   * Todos los exámenes del curso: el general (moduleId null) primero y luego
   * los de cada módulo en su orden. Vacío si el curso no tiene exámenes.
   */
  quizzes: QuizMetrics[];
  /**
   * @deprecated Usar `quizzes`. Se mantiene para los clientes desplegados
   * antes de que el informe distinguiera los varios exámenes de un curso;
   * refleja el examen general (o el primero, si no hay general).
   */
  quiz: {
    exists: boolean;
    passingScore: number | null;
    totalAttempts: number;
    uniqueUsers: number;
    graded: number;
    pending: number;
    review: number;
    avgBestScore: number | null;
    passedUsers: number | null;
    gradedUsers: number;
  };
  certificates: {
    total: number;
    completed: number;
    pending: number;
    failed: number;
  };
}

export interface EventMemberActivityProgress {
  activityId: string;
  progress: number;
  completed: boolean;
  timeSpentMs: number;
}

export type EventMemberCertificateStatus =
  | 'COMPLETED'
  | 'PENDING'
  | 'FAILED'
  | 'NOT_GENERATED';

export interface EventMember {
  userId: string;
  name: string;
  email: string;
  courseProgress: number;
  status: 'completed' | 'in_progress' | 'not_started';
  enrolledAt: Date | null;
  certificateStatus: EventMemberCertificateStatus;
  activities: EventMemberActivityProgress[];
}

export interface EventMembersMetrics {
  activities: {
    activityId: string;
    name: string;
    moduleName: string | null;
    moduleOrder: number | null;
  }[];
  members: EventMember[];
  total: number;
  page: number;
  pageSize: number;
}

export type EventMembersSortKey = 'name' | 'courseProgress' | 'enrolledAt';

export interface GetEventMembersOptions {
  page?: number;
  pageSize?: number;
  search?: string;
  sortKey?: EventMembersSortKey;
  sortDir?: 'asc' | 'desc';
}

@Injectable()
export class EventMetricsService {
  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(CourseAttendee.name)
    private readonly courseAttendeeModel: Model<CourseAttendee>,
    @InjectModel(ActivityAttendee.name)
    private readonly activityAttendeeModel: Model<ActivityAttendee>,
    @InjectModel(Activity.name) private readonly activityModel: Model<Activity>,
    @InjectModel('Module') private readonly moduleModel: Model<CourseModule>,
    @InjectModel(UserActivity.name)
    private readonly userActivityModel: Model<UserActivity>,
    @InjectModel(Quiz.name) private readonly quizModel: Model<QuizDocument>,
    @InjectModel(UserQuizAttempt.name)
    private readonly attemptModel: Model<UserQuizAttempt>,
    @InjectModel(Certificate.name)
    private readonly certificateModel: Model<Certificate>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(OrganizationUser.name)
    private readonly organizationUserModel: Model<OrganizationUser>,
  ) {}

  // Caché en memoria de las partes costosas (agregaciones + resolución de
  // nombres) de este dashboard de admin. TTL corto: prioriza no repetir el
  // trabajo caro cuando el admin cambia de pestaña o pagina/busca/ordena,
  // aceptando datos hasta CACHE_TTL_MS desactualizados. La validación de
  // pertenencia del evento a la organización nunca se cachea (ver
  // getEventMetrics/getEventMembers), así que esto no relaja el aislamiento
  // por organización.
  private readonly cache = new Map<string, { data: any; expiresAt: number }>();
  private readonly CACHE_TTL_MS = 45_000;

  private async getCached<T>(
    key: string,
    factory: () => Promise<T>,
  ): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.data as T;
    const data = await factory();
    this.cache.set(key, { data, expiresAt: Date.now() + this.CACHE_TTL_MS });
    return data;
  }

  /**
   * Devuelve las dos representaciones posibles de un id (string y ObjectId).
   * La data histórica es heterogénea: `event_id`/`user_id`/`activity_id`
   * pueden estar guardados como string o como ObjectId según cómo se insertó
   * el registro. Las agregaciones no castean (a diferencia de los find de
   * Mongoose), así que hay que matchear con ambas formas para no dejar
   * registros por fuera. Mismo patrón que CourseAttendeeService.idVariants.
   */
  private idVariants(id: string | Types.ObjectId): any[] {
    const raw = String(id);
    const out: any[] = [raw];
    if (
      Types.ObjectId.isValid(raw) &&
      String(new Types.ObjectId(raw)) === raw
    ) {
      out.push(new Types.ObjectId(raw));
    }
    return out;
  }

  async getEventMetrics(
    eventId: string,
    organizationId: string,
  ): Promise<EventMetrics> {
    const event = await this.eventModel.findById(eventId).exec();
    // Se responde 404 (y no 403) para no revelar la existencia de eventos de
    // otras organizaciones.
    if (!event || String(event.organizer_id) !== String(organizationId)) {
      throw new NotFoundException('Evento no encontrado');
    }

    const { enrollment, time, activities, quizzes, certificates } =
      await this.getCached(`metrics:${eventId}`, async () => {
        const eventObjectId = new Types.ObjectId(eventId);
        const eventVals = this.idVariants(eventId);

        const [enrollment, time, activities, quizzes, certificates] =
          await Promise.all([
            this.getEnrollmentMetrics(eventVals),
            this.getCourseTimeMetrics(eventId),
            this.getActivityMetrics(eventVals),
            this.getQuizMetrics(eventObjectId, eventVals),
            this.getCertificateMetrics(eventVals),
          ]);

        return { enrollment, time, activities, quizzes, certificates };
      });

    return {
      event: {
        id: String(event._id),
        name: event.name,
        datetime_from: event.datetime_from,
        datetime_to: event.datetime_to,
      },
      enrollment,
      time,
      activities,
      quizzes,
      quiz: this.toLegacyQuiz(quizzes),
      certificates,
    };
  }

  /**
   * Compacta `quizzes` en el campo `quiz` antiguo (ver EventMetrics): el
   * examen general si existe, si no el primero de la lista.
   */
  private toLegacyQuiz(quizzes: QuizMetrics[]): EventMetrics['quiz'] {
    const main = quizzes.find((q) => q.moduleId === null) ?? quizzes[0];
    if (!main) {
      return {
        exists: false,
        passingScore: null,
        totalAttempts: 0,
        uniqueUsers: 0,
        graded: 0,
        pending: 0,
        review: 0,
        avgBestScore: null,
        passedUsers: null,
        gradedUsers: 0,
      };
    }
    return {
      exists: true,
      passingScore: main.passingScore,
      totalAttempts: main.totalAttempts,
      uniqueUsers: main.uniqueUsers,
      graded: main.graded,
      pending: main.pending,
      review: main.review,
      avgBestScore: main.avgBestScore,
      passedUsers: main.passedUsers,
      gradedUsers: main.gradedUsers,
    };
  }

  // Puede haber inscripciones duplicadas para un mismo usuario con ids en
  // distinto tipo (el índice único user_id+event_id no cruza string/ObjectId),
  // así que se agrupa por usuario (normalizado a string) antes de contar.
  private async getEnrollmentMetrics(eventVals: any[]) {
    const [stats] = await this.courseAttendeeModel.aggregate([
      { $match: { event_id: { $in: eventVals } } },
      {
        $group: {
          _id: { $toString: '$user_id' },
          progress: { $max: { $ifNull: ['$progress', 0] } },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $gte: ['$progress', 100] }, 1, 0] },
          },
          notStarted: {
            $sum: { $cond: [{ $lte: ['$progress', 0] }, 1, 0] },
          },
          avgProgress: { $avg: '$progress' },
        },
      },
    ]);

    const byMonth = await this.courseAttendeeModel.aggregate([
      { $match: { event_id: { $in: eventVals }, createdAt: { $ne: null } } },
      {
        $group: {
          _id: { $toString: '$user_id' },
          createdAt: { $min: '$createdAt' },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const total = stats?.total ?? 0;
    const completed = stats?.completed ?? 0;
    const notStarted = stats?.notStarted ?? 0;

    return {
      total,
      completed,
      notStarted,
      inProgress: Math.max(total - completed - notStarted, 0),
      avgProgress: Math.round((stats?.avgProgress ?? 0) * 10) / 10,
      byMonth: byMonth.map((m) => ({ month: m._id, count: m.count })),
    };
  }

  // UserActivity guarda event_id como string dentro de los arrays courses[]
  // y activities[], por eso aquí se filtra con el id en texto plano.
  private async getCourseTimeMetrics(eventId: string) {
    const [stats] = await this.userActivityModel.aggregate([
      { $match: { 'courses.event_id': eventId } },
      { $unwind: '$courses' },
      { $match: { 'courses.event_id': eventId } },
      {
        $group: {
          _id: '$user_id',
          timeMs: { $sum: '$courses.time_spent_ms' },
        },
      },
      {
        $group: {
          _id: null,
          totalMs: { $sum: '$timeMs' },
          usersWithTime: { $sum: 1 },
        },
      },
    ]);

    const totalMs = stats?.totalMs ?? 0;
    const usersWithTime = stats?.usersWithTime ?? 0;
    return {
      totalMs,
      usersWithTime,
      avgPerUserMs: usersWithTime > 0 ? Math.round(totalMs / usersWithTime) : 0,
    };
  }

  /**
   * Actividades de un evento con su módulo resuelto, más las dos
   * representaciones de id de cada actividad (ver idVariants) para poder
   * matchear activity-attendee/user-activity sin depender de cómo se guardó
   * el tipo del id.
   */
  private async loadActivitiesWithModules(eventVals: any[]): Promise<{
    activities: any[];
    moduleById: Map<string, any>;
    activityVals: any[];
  }> {
    const [activities, modules] = await Promise.all([
      this.activityModel.collection
        .find(
          { event_id: { $in: eventVals } },
          {
            projection: {
              name: 1,
              module_id: 1,
              create_at: 1,
              created_at: 1,
              createdAt: 1,
            },
          },
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
    // Registros antiguos de activity-attendee pueden no tener event_id (o
    // tenerlo en otro tipo); se recuperan también por activity_id, igual que
    // ActivityAttendeeService.findByUserIdAndEventId.
    const activityVals = activities.flatMap((a: any) => this.idVariants(a._id));

    return { activities, moduleById, activityVals };
  }

  /**
   * Fecha de creación de una actividad en milisegundos. La colección mezcla
   * tres grafías del campo según la época del registro (`create_at` en la data
   * antigua, `createdAt` desde que el schema usa timestamps); es el mismo
   * fallback de `sortActivitiesByDate` en el front. Las actividades sin fecha
   * quedan al final de su módulo en vez de encabezarlo.
   */
  private createdAtMs(activity: any): number {
    const raw =
      activity?.create_at ?? activity?.created_at ?? activity?.createdAt;
    if (!raw) return Number.MAX_SAFE_INTEGER;
    const ms = new Date(raw).getTime();
    return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
  }

  /**
   * Orden del embudo y de la tabla de miembros = orden real de aprendizaje del
   * curso: módulos por `order` y, dentro de cada uno, actividades por fecha de
   * creación (la colección `activities` no tiene campo de orden propio). Es el
   * mismo criterio de `getOrderedActivities`/`sortActivitiesByDate` en el front
   * (pages/course/helpers/courseDetailHelpers.ts): si divergen, el admin ve las
   * actividades en un orden distinto al que recorre el alumno. El nombre queda
   * solo como desempate final para que el orden sea estable.
   */
  private compareActivityOrder(
    a: { moduleOrder: number | null; name: string; createdAtMs: number },
    b: { moduleOrder: number | null; name: string; createdAtMs: number },
  ): number {
    const orderA = a.moduleOrder ?? Number.MAX_SAFE_INTEGER;
    const orderB = b.moduleOrder ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
    return a.name.localeCompare(b.name);
  }

  private async getActivityMetrics(
    eventVals: any[],
  ): Promise<ActivityMetrics[]> {
    // event_id del filtro de UserActivity siempre es string (ver
    // getCourseTimeMetrics); el resto de colecciones tienen tipos mixtos y se
    // consultan con el driver nativo para evitar el casteo de Mongoose.
    const eventIdStr = String(eventVals[0]);

    const { activities, moduleById, activityVals } =
      await this.loadActivitiesWithModules(eventVals);

    const attendeeMatch: any[] = [{ event_id: { $in: eventVals } }];
    if (activityVals.length) {
      attendeeMatch.push({ activity_id: { $in: activityVals } });
    }

    const [attendeeStats, timeStats] = await Promise.all([
      this.activityAttendeeModel.aggregate([
        { $match: { $or: attendeeMatch } },
        // Dedupe usuario+actividad: puede haber duplicados con ids en
        // distinto tipo (string vs ObjectId).
        {
          $group: {
            _id: {
              activity: { $toString: '$activity_id' },
              user: { $toString: '$user_id' },
            },
            progress: { $max: { $ifNull: ['$progress', 0] } },
          },
        },
        {
          $group: {
            _id: '$_id.activity',
            attendees: { $sum: 1 },
            completed: {
              $sum: { $cond: [{ $gte: ['$progress', 100] }, 1, 0] },
            },
            avgProgress: { $avg: '$progress' },
          },
        },
      ]),
      this.userActivityModel.aggregate([
        { $match: { 'activities.event_id': eventIdStr } },
        { $unwind: '$activities' },
        { $match: { 'activities.event_id': eventIdStr } },
        {
          $group: {
            _id: '$activities.activity_id',
            totalMs: { $sum: '$activities.time_spent_ms' },
            usersWithTime: { $sum: 1 },
          },
        },
      ]),
    ]);

    const attendeesByActivity = new Map(
      attendeeStats.map((s: any) => [String(s._id), s]),
    );
    const timeByActivity = new Map(
      timeStats.map((s: any) => [String(s._id), s]),
    );

    const result = activities.map((activity: any) => {
      const id = String(activity._id);
      const mod = activity.module_id
        ? moduleById.get(String(activity.module_id))
        : null;
      const att: any = attendeesByActivity.get(id);
      const time: any = timeByActivity.get(id);
      return {
        activityId: id,
        name: activity.name,
        moduleId: activity.module_id ?? null,
        moduleName: mod?.module_name ?? null,
        moduleOrder: mod?.order ?? null,
        attendees: att?.attendees ?? 0,
        completed: att?.completed ?? 0,
        avgProgress: Math.round((att?.avgProgress ?? 0) * 10) / 10,
        totalTimeMs: time?.totalMs ?? 0,
        usersWithTime: time?.usersWithTime ?? 0,
        createdAtMs: this.createdAtMs(activity),
      };
    });

    result.sort((a, b) => this.compareActivityOrder(a, b));

    // `createdAtMs` es auxiliar para ordenar; no viaja al cliente.
    return result.map(({ createdAtMs, ...activity }) => activity);
  }

  /**
   * Métricas de todos los exámenes del curso. Un evento puede tener varios
   * (uno general + uno por módulo), así que se calcula uno por uno y se
   * identifica cada resultado con su módulo; antes se tomaba un examen
   * cualquiera con findOne y el informe no decía a cuál correspondía.
   */
  private async getQuizMetrics(
    eventObjectId: Types.ObjectId,
    eventVals: any[],
  ): Promise<QuizMetrics[]> {
    const [quizzes, modules] = await Promise.all([
      this.quizModel
        .find({ eventId: eventObjectId })
        .select('config moduleId enabled')
        .lean()
        .exec(),
      this.moduleModel.collection
        .find(
          { event_id: { $in: eventVals } },
          { projection: { module_name: 1, order: 1 } },
        )
        .toArray(),
    ]);

    if (!quizzes.length) return [];

    const moduleById = new Map(modules.map((m: any) => [String(m._id), m]));

    const stats = await Promise.all(
      quizzes.map((quiz: any) =>
        this.getSingleQuizStats(String(quiz._id), quiz.config?.nota ?? null),
      ),
    );

    const result: QuizMetrics[] = quizzes.map((quiz: any, i: number) => {
      const mod = quiz.moduleId
        ? moduleById.get(String(quiz.moduleId))
        : null;
      return {
        quizId: String(quiz._id),
        moduleId: quiz.moduleId ? String(quiz.moduleId) : null,
        moduleName: mod?.module_name ?? null,
        moduleOrder: mod?.order ?? null,
        enabled: quiz.enabled !== false,
        passingScore: quiz.config?.nota ?? null,
        ...stats[i],
      };
    });

    // El examen general primero; luego los de módulo en el orden del curso.
    return result.sort((a, b) => {
      if (!a.moduleId !== !b.moduleId) return a.moduleId ? 1 : -1;
      const orderA = a.moduleOrder ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.moduleOrder ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return (a.moduleName ?? '').localeCompare(b.moduleName ?? '');
    });
  }

  /**
   * Conteos de intentos y notas de un único examen. `passingScore` se recibe
   * ya resuelto porque cada examen tiene su propia nota mínima.
   */
  private async getSingleQuizStats(
    quizId: string,
    passingScore: number | null,
  ) {
    const empty = {
      totalAttempts: 0,
      uniqueUsers: 0,
      graded: 0,
      pending: 0,
      review: 0,
      avgBestScore: null as number | null,
      passedUsers: null as number | null,
      gradedUsers: 0,
    };

    // Métricas por usuario (mejor nota entre intentos calificados) y por
    // intento (conteos por estado) en una sola pasada.
    const [stats] = await this.attemptModel.aggregate([
      { $match: { quizId } },
      {
        $group: {
          _id: '$userId',
          attempts: { $sum: 1 },
          graded: { $sum: { $cond: [{ $eq: ['$status', 'graded'] }, 1, 0] } },
          pending: {
            $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] },
          },
          review: { $sum: { $cond: [{ $eq: ['$status', 'review'] }, 1, 0] } },
          bestScore: {
            $max: {
              $cond: [{ $eq: ['$status', 'graded'] }, '$score', null],
            },
          },
        },
      },
      {
        $group: {
          _id: null,
          totalAttempts: { $sum: '$attempts' },
          uniqueUsers: { $sum: 1 },
          graded: { $sum: '$graded' },
          pending: { $sum: '$pending' },
          review: { $sum: '$review' },
          gradedUsers: {
            $sum: { $cond: [{ $ne: ['$bestScore', null] }, 1, 0] },
          },
          avgBestScore: { $avg: '$bestScore' },
          passedUsers: {
            $sum:
              passingScore !== null
                ? {
                    $cond: [
                      {
                        $and: [
                          { $ne: ['$bestScore', null] },
                          { $gte: ['$bestScore', passingScore] },
                        ],
                      },
                      1,
                      0,
                    ],
                  }
                : 0,
          },
        },
      },
    ]);

    if (!stats) return empty;

    return {
      totalAttempts: stats.totalAttempts,
      uniqueUsers: stats.uniqueUsers,
      graded: stats.graded,
      pending: stats.pending,
      review: stats.review,
      gradedUsers: stats.gradedUsers,
      avgBestScore:
        stats.avgBestScore !== null
          ? Math.round(stats.avgBestScore * 10) / 10
          : null,
      passedUsers: passingScore !== null ? stats.passedUsers : null,
    };
  }

  private async getCertificateMetrics(eventVals: any[]) {
    const byStatus = await this.certificateModel.aggregate([
      { $match: { eventId: { $in: eventVals } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const counts = new Map(byStatus.map((s: any) => [s._id, s.count]));
    const completed = counts.get('COMPLETED') ?? 0;
    const pending = counts.get('PENDING') ?? 0;
    const failed = counts.get('FAILED') ?? 0;

    return {
      total: completed + pending + failed,
      completed,
      pending,
      failed,
    };
  }

  /**
   * Avance de cada miembro inscrito, actividad por actividad. Complementa el
   * embudo agregado de getActivityMetrics con el detalle por usuario que
   * necesita el admin para ver quién se quedó atrás y en qué actividad.
   */
  async getEventMembers(
    eventId: string,
    organizationId: string,
    options: GetEventMembersOptions = {},
  ): Promise<EventMembersMetrics> {
    const event = await this.eventModel.findById(eventId).exec();
    if (!event || String(event.organizer_id) !== String(organizationId)) {
      throw new NotFoundException('Evento no encontrado');
    }

    // Solo la organización dueña del evento llega hasta acá (ver validación
    // arriba), así que para un mismo eventId el organizationId siempre es el
    // mismo: cachear por eventId solo es seguro.
    const resolved = await this.getCached(`members:${eventId}`, () =>
      this.resolveEventMembers(eventId, organizationId),
    );

    return this.paginateMembers(resolved.activities, resolved.members, options);
  }

  /**
   * Resuelve la lista completa de miembros inscritos (sin paginar). Es la
   * parte cara del endpoint (joins con organization-users/users y fallback a
   * Firebase Auth) y por eso getEventMembers la cachea entera: paginar,
   * buscar u ordenar entre requests reutiliza este trabajo en vez de
   * repetirlo.
   */
  private async resolveEventMembers(
    eventId: string,
    organizationId: string,
  ): Promise<{
    activities: EventMembersMetrics['activities'];
    members: EventMember[];
  }> {
    const eventVals = this.idVariants(eventId);

    const [enrollment, { activities, moduleById, activityVals }] =
      await Promise.all([
        this.courseAttendeeModel.aggregate([
          { $match: { event_id: { $in: eventVals } } },
          {
            $group: {
              _id: { $toString: '$user_id' },
              progress: { $max: { $ifNull: ['$progress', 0] } },
              enrolledAt: { $min: '$createdAt' },
            },
          },
          { $sort: { enrolledAt: 1 } },
        ]),
        this.loadActivitiesWithModules(eventVals),
      ]);

    const activityMeta = activities
      .map((activity: any) => {
        const mod = activity.module_id
          ? moduleById.get(String(activity.module_id))
          : null;
        return {
          activityId: String(activity._id),
          name: activity.name,
          moduleName: mod?.module_name ?? null,
          moduleOrder: mod?.order ?? null,
          createdAtMs: this.createdAtMs(activity),
        };
      })
      .sort((a, b) => this.compareActivityOrder(a, b))
      .map(({ createdAtMs, ...activity }) => activity);

    if (enrollment.length === 0) {
      return { activities: activityMeta, members: [] };
    }

    // event_id del filtro de UserActivity siempre es string (ver
    // getCourseTimeMetrics).
    const eventIdStr = String(eventVals[0]);
    const attendeeMatch: any[] = [{ event_id: { $in: eventVals } }];
    if (activityVals.length) {
      attendeeMatch.push({ activity_id: { $in: activityVals } });
    }

    const userVals = enrollment.flatMap((m: any) => this.idVariants(m._id));

    const [attendanceByUser, timeByUser, users, orgUsers, certificatesByUser] =
      await Promise.all([
        this.activityAttendeeModel.aggregate([
          { $match: { $or: attendeeMatch } },
          // Dedupe usuario+actividad: puede haber duplicados con ids en
          // distinto tipo (string vs ObjectId). A diferencia de
          // getActivityMetrics, aquí no se colapsa por actividad: se necesita
          // el progreso de cada usuario.
          {
            $group: {
              _id: {
                activity: { $toString: '$activity_id' },
                user: { $toString: '$user_id' },
              },
              progress: { $max: { $ifNull: ['$progress', 0] } },
            },
          },
        ]),
        this.userActivityModel.aggregate([
          { $match: { 'activities.event_id': eventIdStr } },
          { $unwind: '$activities' },
          { $match: { 'activities.event_id': eventIdStr } },
          {
            $group: {
              _id: {
                activity: '$activities.activity_id',
                user: '$user_id',
              },
              timeMs: { $sum: '$activities.time_spent_ms' },
            },
          },
        ]),
        this.userModel.collection
          .find(
            { _id: { $in: userVals } },
            { projection: { names: 1, email: 1 } },
          )
          .toArray(),
        // El nombre/correo "de la organización" vive en properties (config
        // dinámica por organización, ver OrganizationUsersService.findByEmail y
        // MembersTab.tsx), no en el User base: para miembros importados o
        // creados directamente en el flujo de organización, User.names/email
        // suele quedar vacío. No se filtra por organization_id: un miembro
        // puede estar inscrito a un curso de esta organización pero tener su
        // registro de organization-user en otra (multi-org); se prefiere el de
        // esta organización pero se acepta cualquiera antes que no mostrar nada.
        this.organizationUserModel.collection
          .find(
            { user_id: { $in: userVals } },
            { projection: { properties: 1, user_id: 1, organization_id: 1 } },
          )
          .toArray(),
        // Un usuario puede tener varios certificados para el mismo evento (p.
        // ej. si se regeneró tras un FAILED); se ordena por fecha de creación
        // descendente y $first se queda con el más reciente por usuario.
        this.certificateModel.aggregate([
          { $match: { eventId: { $in: eventVals }, userId: { $in: userVals } } },
          { $sort: { createdAt: -1 } },
          {
            $group: {
              _id: { $toString: '$userId' },
              status: { $first: '$status' },
            },
          },
        ]),
      ]);

    const progressByKey = new Map(
      attendanceByUser.map((a: any) => [
        `${a._id.activity}|${a._id.user}`,
        a.progress,
      ]),
    );
    const timeByKey = new Map(
      timeByUser.map((t: any) => [`${t._id.activity}|${t._id.user}`, t.timeMs]),
    );
    const userById = new Map(users.map((u: any) => [String(u._id), u]));
    const certificateStatusByUser = new Map<string, EventMemberCertificateStatus>(
      certificatesByUser.map((c: any) => [c._id, c.status]),
    );

    const orgUsersByUserId = new Map<string, any[]>();
    for (const ou of orgUsers as any[]) {
      const key = String(ou.user_id);
      if (!orgUsersByUserId.has(key)) orgUsersByUserId.set(key, []);
      orgUsersByUserId.get(key)!.push(ou);
    }
    const pickOrgUser = (userId: string): any => {
      const list = orgUsersByUserId.get(userId);
      if (!list || list.length === 0) return null;
      return (
        list.find(
          (ou) => String(ou.organization_id) === String(organizationId),
        ) ?? list[0]
      );
    };

    const draftMembers = enrollment.map((m: any) => {
      const user: any = userById.get(m._id);
      const orgUser = pickOrgUser(m._id);
      const props = orgUser?.properties || {};

      // El perfil de organización (properties) es la fuente de verdad del
      // nombre/correo mostrado al admin; el User base es solo respaldo (ver
      // comentario junto a la consulta de organizationUserModel más arriba).
      const fullName = [props.nombres, props.apellidos]
        .filter(Boolean)
        .join(' ')
        .trim();
      const name: string | null =
        fullName || props.names || props.name || user?.names || null;
      const email: string = props.email || props.correo || user?.email || '';

      return { m, name, email, userExists: !!user };
    });

    // Último recurso: usuarios activos (tienen progreso real) sin User ni
    // organization-user — por ejemplo si la cuenta se creó a medias y el
    // documento User nunca llegó a persistirse. UserActivity sí guarda el
    // firebase_uid en la raíz del documento (no depende de User), así que se
    // usa para resolver nombre/correo directo desde Firebase Auth.
    const unresolvedIds = draftMembers
      .filter((d) => !d.name)
      .map((d) => String(d.m._id));

    const firebaseByUserId = new Map<
      string,
      { name?: string; email?: string }
    >();
    if (unresolvedIds.length > 0) {
      const uaDocs = await this.userActivityModel.collection
        .find(
          { user_id: { $in: unresolvedIds } },
          { projection: { user_id: 1, firebase_uid: 1 } },
        )
        .toArray();
      const firebaseUidByUserId = new Map(
        uaDocs.map((d: any) => [String(d.user_id), d.firebase_uid]),
      );
      // userId por cada uid, para poder ir de vuelta de UserRecord a userId
      // después del lookup batch (varios userId nunca deberían compartir
      // firebase_uid, pero se usa el último por las dudas).
      const userIdByUid = new Map<string, string>();
      const uids = new Set<string>();
      for (const [userId, uid] of firebaseUidByUserId) {
        if (!uid) continue;
        uids.add(uid);
        userIdByUid.set(uid, userId);
      }

      // admin.auth().getUsers() acepta hasta 100 identificadores por llamada:
      // se agrupan los uids en chunks de 100 y se resuelven en batch en vez
      // de un getUser() por usuario (evita un fan-out sin límite hacia
      // Firebase Auth cuando hay muchas cuentas huérfanas).
      const uidList = Array.from(uids);
      const CHUNK_SIZE = 100;
      const chunks: string[][] = [];
      for (let i = 0; i < uidList.length; i += CHUNK_SIZE) {
        chunks.push(uidList.slice(i, i + CHUNK_SIZE));
      }

      await Promise.all(
        chunks.map(async (chunk) => {
          try {
            const result = await admin
              .auth()
              .getUsers(chunk.map((uid) => ({ uid })));
            for (const fbUser of result.users) {
              const userId = userIdByUid.get(fbUser.uid);
              if (!userId) continue;
              firebaseByUserId.set(userId, {
                name: fbUser.displayName,
                email: fbUser.email,
              });
            }
            // Los uids en result.notFound quedan sin resolver: cuenta de
            // Firebase también inexistente/eliminada, cae al fallback
            // "Usuario sin nombre".
          } catch {
            // Falla del batch completo (p. ej. error de red): se deja el
            // chunk sin resolver en vez de reintentar uno por uno.
          }
        }),
      );
    }

    const members: EventMember[] = draftMembers.map(
      ({ m, name, email, userExists }) => {
        const fallback = firebaseByUserId.get(String(m._id));
        const memberActivities = activityMeta.map((meta) => {
          const key = `${meta.activityId}|${m._id}`;
          const progress = progressByKey.get(key) ?? 0;
          return {
            activityId: meta.activityId,
            progress: Math.round(progress),
            completed: progress >= 100,
            timeSpentMs: timeByKey.get(key) ?? 0,
          };
        });

        const resolvedName = name || fallback?.name || null;
        // Si ni el User base ni Firebase Auth tienen rastro de esta persona,
        // es casi siempre porque la cuenta fue eliminada desde el admin
        // (OrganizationUsersService.deleteOrganizationUser borra el User y el
        // organization-user, pero no los registros de asistencia/progreso que
        // ya generó) — se etiqueta distinto de un perfil real simplemente sin
        // nombre cargado.
        const name_ =
          resolvedName ??
          (userExists || fallback ? 'Usuario sin nombre' : 'Cuenta eliminada');

        const courseProgress = Math.round(m.progress ?? 0);
        return {
          userId: m._id,
          name: name_,
          email: email || fallback?.email || '',
          courseProgress,
          status:
            courseProgress >= 100
              ? 'completed'
              : courseProgress > 0
                ? 'in_progress'
                : 'not_started',
          certificateStatus:
            certificateStatusByUser.get(String(m._id)) ?? 'NOT_GENERATED',
          enrolledAt: m.enrolledAt ?? null,
          activities: memberActivities,
        };
      },
    );

    return { activities: activityMeta, members };
  }

  /**
   * Aplica búsqueda, orden y paginación en memoria sobre la lista completa
   * ya resuelta (y cacheada) de miembros. Mismo criterio de orden que usaba
   * antes el frontend (EventMembersPanel.tsx), ahora server-side.
   */
  private paginateMembers(
    activityMeta: EventMembersMetrics['activities'],
    members: EventMember[],
    options: GetEventMembersOptions,
  ): EventMembersMetrics {
    const sortKey = options.sortKey ?? 'enrolledAt';
    const sortDir = options.sortDir ?? 'asc';
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.min(
      200,
      Math.max(1, Math.floor(options.pageSize ?? 50)),
    );

    const term = options.search?.trim().toLowerCase();
    const filtered = term
      ? members.filter(
          (m) =>
            m.name.toLowerCase().includes(term) ||
            m.email.toLowerCase().includes(term),
        )
      : members;

    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortKey === 'courseProgress')
        cmp = a.courseProgress - b.courseProgress;
      else
        cmp = String(a.enrolledAt ?? '').localeCompare(
          String(b.enrolledAt ?? ''),
        );
      return sortDir === 'asc' ? cmp : -cmp;
    });

    const total = sorted.length;
    const start = (page - 1) * pageSize;

    return {
      activities: activityMeta,
      members: sorted.slice(start, start + pageSize),
      total,
      page,
      pageSize,
    };
  }
}
