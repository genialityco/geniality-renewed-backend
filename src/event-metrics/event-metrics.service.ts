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

  private async getActivityMetrics(
    eventVals: any[],
  ): Promise<ActivityMetrics[]> {
    // event_id del filtro de UserActivity siempre es string (ver
    // getCourseTimeMetrics); el resto de colecciones tienen tipos mixtos y se
    // consultan con el driver nativo para evitar el casteo de Mongoose.
    const eventIdStr = String(eventVals[0]);

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

    // Registros antiguos de activity-attendee pueden no tener event_id (o
    // tenerlo en otro tipo); se recuperan también por activity_id, igual que
    // ActivityAttendeeService.findByUserIdAndEventId.
    const activityVals = activities.flatMap((a: any) => this.idVariants(a._id));
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

    const moduleById = new Map(modules.map((m: any) => [String(m._id), m]));
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

    // Orden estable para el embudo: por orden de módulo y luego por nombre.
    result.sort((a, b) => {
      const orderA = a.moduleOrder ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.moduleOrder ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });

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
}
