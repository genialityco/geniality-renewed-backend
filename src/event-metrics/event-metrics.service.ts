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

export interface EventMember {
  userId: string;
  name: string;
  email: string;
  courseProgress: number;
  status: 'completed' | 'in_progress' | 'not_started';
  enrolledAt: Date | null;
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

    const eventObjectId = new Types.ObjectId(eventId);
    const eventVals = this.idVariants(eventId);

    const [enrollment, time, activities, quiz, certificates] =
      await Promise.all([
        this.getEnrollmentMetrics(eventVals),
        this.getCourseTimeMetrics(eventId),
        this.getActivityMetrics(eventVals),
        this.getQuizMetrics(eventObjectId),
        this.getCertificateMetrics(eventVals),
      ]);

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
      quiz,
      certificates,
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
          { projection: { name: 1, module_id: 1 } },
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

  // Orden estable para el embudo y la tabla de miembros: por orden de módulo
  // y luego por nombre.
  private compareActivityOrder(
    a: { moduleOrder: number | null; name: string },
    b: { moduleOrder: number | null; name: string },
  ): number {
    const orderA = a.moduleOrder ?? Number.MAX_SAFE_INTEGER;
    const orderB = b.moduleOrder ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
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
      };
    });

    result.sort((a, b) => this.compareActivityOrder(a, b));

    return result;
  }

  private async getQuizMetrics(eventObjectId: Types.ObjectId) {
    const empty = {
      exists: false,
      passingScore: null as number | null,
      totalAttempts: 0,
      uniqueUsers: 0,
      graded: 0,
      pending: 0,
      review: 0,
      avgBestScore: null as number | null,
      passedUsers: null as number | null,
      gradedUsers: 0,
    };

    const quiz = await this.quizModel
      .findOne({ eventId: eventObjectId })
      .select('config')
      .exec();
    if (!quiz) return empty;

    const passingScore = quiz.config?.nota ?? null;

    // Métricas por usuario (mejor nota entre intentos calificados) y por
    // intento (conteos por estado) en una sola pasada.
    const [stats] = await this.attemptModel.aggregate([
      { $match: { quizId: String(quiz._id) } },
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

    if (!stats) return { ...empty, exists: true, passingScore };

    return {
      exists: true,
      passingScore,
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
  ): Promise<EventMembersMetrics> {
    const event = await this.eventModel.findById(eventId).exec();
    if (!event || String(event.organizer_id) !== String(organizationId)) {
      throw new NotFoundException('Evento no encontrado');
    }

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
        };
      })
      .sort((a, b) => this.compareActivityOrder(a, b));

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
    const orgVals = this.idVariants(organizationId);

    const [attendanceByUser, timeByUser, users, orgUsers] = await Promise.all([
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
        .find({ _id: { $in: userVals } }, { projection: { names: 1, email: 1 } })
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

    const firebaseByUserId = new Map<string, { name?: string; email?: string }>();
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

      await Promise.all(
        unresolvedIds.map(async (userId) => {
          const uid = firebaseUidByUserId.get(userId);
          if (!uid) return;
          try {
            const fbUser = await admin.auth().getUser(uid);
            firebaseByUserId.set(userId, {
              name: fbUser.displayName,
              email: fbUser.email,
            });
          } catch {
            // Cuenta de Firebase también inexistente/eliminada: se deja sin
            // resolver, cae al fallback "Usuario sin nombre".
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
          enrolledAt: m.enrolledAt ?? null,
          activities: memberActivities,
        };
      },
    );

    return { activities: activityMeta, members };
  }
}
