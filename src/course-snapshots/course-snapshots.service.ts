import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import {
  CourseSnapshot,
  CourseSnapshotKind,
  CourseSnapshotMetrics,
} from './schemas/course-snapshot.schema';
import {
  CompletedAtSource,
  CourseSnapshotUser,
  CourseUserStatus,
} from './schemas/course-snapshot-user.schema';
import { Event } from '../events/schemas/event.schema';
import { CourseAttendee } from '../course-attendee/schemas/course-attendee.schema';
import { ActivityAttendee } from '../activity-attendee/schemas/activity-attendee.schema';
import { Activity } from '../activities/schemas/activity.schema';
import { UserActivity } from '../user-activity/schemas/user-activity.schema';
import { Certificate } from '../certificates/schemas/certificate.schema';
import { OrganizationUser } from '../organization-users/schemas/organization-user.schema';
import { Organization } from '../organizations/schemas/organization.schema';
import { hasWhatsappConsent } from '../common/whatsapp-consent';
import { User } from '../users/schemas/user.schema';
import {
  resolveEmail,
  resolveName,
  resolvePhone,
} from '../reminders/contact.util';

const DAY_MS = 24 * 60 * 60 * 1000;
// Umbral de "inactivo" de la línea base (el mismo que usarán las campañas)
const INACTIVE_DAYS = 15;
const TIMEZONE = 'America/Bogota';

interface UserRow {
  user_id: string;
  enrolled_at: Date | null;
  course_progress: number;
  activity_progress: number;
  status: CourseUserStatus;
  last_activity_at: Date | null;
  days_inactive: number | null;
  time_spent_ms: number;
  completed_at: Date | null;
  completed_at_source: CompletedAtSource;
  has_phone: boolean;
  // Consentimiento efectivo (opt-in, o campo de consentimiento de la
  // organización, sin baja); ver common/whatsapp-consent.ts
  whatsapp_opt_in: boolean;
}

interface EventRef {
  _id: any;
  name?: string;
  organizer_id: any;
}

export interface BaselineSummary {
  batch_id: string;
  label: string | null;
  snapshot_date: string;
  taken_at: Date;
  courses: number;
  enrolled: number;
  completed: number;
}

/** YYYY-MM-DD en la zona horaria de la plataforma. */
export function localDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(d);
}

function idVariants(id: string | Types.ObjectId): any[] {
  const raw = String(id);
  const out: any[] = [raw];
  if (Types.ObjectId.isValid(raw) && String(new Types.ObjectId(raw)) === raw) {
    out.push(new Types.ObjectId(raw));
  }
  return out;
}

function maxDate(...dates: (Date | null | undefined)[]): Date | null {
  let out: Date | null = null;
  for (const d of dates) {
    if (!d) continue;
    const date = new Date(d);
    if (isNaN(date.getTime())) continue;
    if (!out || date > out) out = date;
  }
  return out;
}

function minDate(...dates: (Date | null | undefined)[]): Date | null {
  let out: Date | null = null;
  for (const d of dates) {
    if (!d) continue;
    const date = new Date(d);
    if (isNaN(date.getTime())) continue;
    if (!out || date < out) out = date;
  }
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Snapshots de indicadores por curso: líneas base congeladas a mano por el
 * admin (con el detalle por estudiante) y un snapshot diario automático.
 *
 * Las colecciones de avance solo guardan el estado actual, así que esta es
 * la única forma de comparar después "antes vs. después" de las
 * notificaciones con datos de la fecha real y no reconstruidos.
 */
@Injectable()
export class CourseSnapshotsService {
  private readonly logger = new Logger(CourseSnapshotsService.name);

  constructor(
    @InjectModel(CourseSnapshot.name)
    private readonly snapshotModel: Model<CourseSnapshot>,
    @InjectModel(CourseSnapshotUser.name)
    private readonly snapshotUserModel: Model<CourseSnapshotUser>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(CourseAttendee.name)
    private readonly courseAttendeeModel: Model<CourseAttendee>,
    @InjectModel(ActivityAttendee.name)
    private readonly activityAttendeeModel: Model<ActivityAttendee>,
    @InjectModel(Activity.name) private readonly activityModel: Model<Activity>,
    @InjectModel(UserActivity.name)
    private readonly userActivityModel: Model<UserActivity>,
    @InjectModel(Certificate.name)
    private readonly certificateModel: Model<Certificate>,
    @InjectModel(OrganizationUser.name)
    private readonly organizationUserModel: Model<OrganizationUser>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Organization.name)
    private readonly organizationModel: Model<Organization>,
  ) {}

  // ───────────────────────── Líneas base ─────────────────────────

  async createBaseline(
    organizationId: string,
    options: { label?: string; eventIds?: string[]; takenBy?: string | null },
  ): Promise<BaselineSummary> {
    let events = await this.findOrgEvents(organizationId);
    if (options.eventIds?.length) {
      const wanted = new Set(options.eventIds.map(String));
      events = events.filter((e) => wanted.has(String(e._id)));
    }
    if (!events.length) {
      throw new NotFoundException('No hay cursos para congelar');
    }

    const takenAt = new Date();
    const batchId = uuidv4();
    const snapshotDate = localDate(takenAt);
    const label = options.label?.trim() || `Línea base ${snapshotDate}`;

    let courses = 0;
    let enrolled = 0;
    let completed = 0;
    for (const event of events) {
      const { metrics, rows } = await this.computeEvent(
        event,
        organizationId,
        takenAt,
      );
      // Cursos sin inscritos no aportan a la línea base
      if (!metrics.enrolled) continue;

      const snapshot = await this.snapshotModel.create({
        organization_id: organizationId,
        event_id: String(event._id),
        event_name: event.name || '',
        kind: 'baseline' as CourseSnapshotKind,
        snapshot_date: snapshotDate,
        batch_id: batchId,
        label,
        taken_at: takenAt,
        taken_by: options.takenBy || null,
        inactive_days: INACTIVE_DAYS,
        metrics,
      });

      const docs = rows.map((r) => ({
        ...r,
        batch_id: batchId,
        snapshot_id: String(snapshot._id),
        organization_id: organizationId,
        event_id: String(event._id),
      }));
      for (let i = 0; i < docs.length; i += 1000) {
        await this.snapshotUserModel.insertMany(docs.slice(i, i + 1000), {
          ordered: false,
        });
      }

      courses++;
      enrolled += metrics.enrolled;
      completed += metrics.completed;
    }

    if (!courses) {
      throw new NotFoundException('Ningún curso tiene inscritos todavía');
    }

    this.logger.log(
      `Línea base "${label}" (${batchId}) de org ${organizationId}: ${courses} cursos`,
    );
    return {
      batch_id: batchId,
      label,
      snapshot_date: snapshotDate,
      taken_at: takenAt,
      courses,
      enrolled,
      completed,
    };
  }

  async listBaselines(organizationId: string): Promise<BaselineSummary[]> {
    const rows = await this.snapshotModel.aggregate([
      { $match: { organization_id: organizationId, kind: 'baseline' } },
      {
        $group: {
          _id: '$batch_id',
          label: { $first: '$label' },
          snapshot_date: { $first: '$snapshot_date' },
          taken_at: { $first: '$taken_at' },
          courses: { $sum: 1 },
          enrolled: { $sum: '$metrics.enrolled' },
          completed: { $sum: '$metrics.completed' },
        },
      },
      { $sort: { taken_at: -1 } },
    ]);
    return rows.map((r) => ({
      batch_id: r._id,
      label: r.label,
      snapshot_date: r.snapshot_date,
      taken_at: r.taken_at,
      courses: r.courses,
      enrolled: r.enrolled,
      completed: r.completed,
    }));
  }

  async getBaseline(organizationId: string, batchId: string) {
    const snapshots = await this.snapshotModel
      .find({
        organization_id: organizationId,
        kind: 'baseline',
        batch_id: batchId,
      })
      .sort({ event_name: 1 })
      .lean()
      .exec();
    if (!snapshots.length)
      throw new NotFoundException('Línea base no encontrada');
    return snapshots;
  }

  /** Detalle por estudiante de un curso de la línea base, con nombre y correo. */
  async getBaselineUsers(
    organizationId: string,
    batchId: string,
    eventId: string,
  ) {
    const rows = await this.snapshotUserModel
      .find({
        organization_id: organizationId,
        batch_id: batchId,
        event_id: eventId,
      })
      .lean()
      .exec();
    if (!rows.length) return [];

    const userIds = rows.map((r) => r.user_id);
    const userVals = userIds.flatMap((id) => idVariants(id));
    const [orgUsers, users] = await Promise.all([
      this.organizationUserModel.collection
        .find(
          {
            organization_id: { $in: idVariants(organizationId) },
            user_id: { $in: userVals },
          },
          { projection: { user_id: 1, properties: 1 } },
        )
        .toArray(),
      this.userModel.collection
        .find(
          { _id: { $in: userVals.filter((v) => v instanceof Types.ObjectId) } },
          { projection: { names: 1, email: 1 } },
        )
        .toArray(),
    ]);
    const orgUserById = new Map(
      orgUsers.map((o: any) => [String(o.user_id), o]),
    );
    const userById = new Map(users.map((u: any) => [String(u._id), u]));

    return rows.map((r) => {
      const orgUser = (orgUserById.get(r.user_id) as any) || null;
      const user = userById.get(r.user_id) || null;
      return {
        ...r,
        name: resolveName(orgUser, user),
        email: resolveEmail(orgUser, user) || '',
      };
    });
  }

  async deleteBaseline(organizationId: string, batchId: string) {
    const res = await this.snapshotModel.deleteMany({
      organization_id: organizationId,
      kind: 'baseline',
      batch_id: batchId,
    });
    if (!res.deletedCount)
      throw new NotFoundException('Línea base no encontrada');
    await this.snapshotUserModel.deleteMany({
      organization_id: organizationId,
      batch_id: batchId,
    });
    return { deleted: res.deletedCount };
  }

  // ───────────────────────── Snapshots diarios ─────────────────────────

  /**
   * Snapshot diario de todos los cursos con inscritos (o solo los de una
   * organización). Upsert por (curso, fecha): re-ejecutarlo el mismo día
   * reemplaza el anterior en vez de duplicarlo.
   */
  async runDaily(organizationId?: string): Promise<{ courses: number }> {
    const events = organizationId
      ? await this.findOrgEvents(organizationId)
      : await this.findEventsWithEnrollments();

    const takenAt = new Date();
    const snapshotDate = localDate(takenAt);
    let courses = 0;
    for (const event of events) {
      try {
        const orgId = String(event.organizer_id);
        const { metrics } = await this.computeEvent(event, orgId, takenAt);
        if (!metrics.enrolled) continue;
        await this.snapshotModel.updateOne(
          {
            event_id: String(event._id),
            kind: 'daily',
            snapshot_date: snapshotDate,
          },
          {
            $set: {
              organization_id: orgId,
              event_name: event.name || '',
              taken_at: takenAt,
              inactive_days: INACTIVE_DAYS,
              metrics,
            },
            $setOnInsert: { batch_id: null, label: null, taken_by: null },
          },
          { upsert: true },
        );
        courses++;
      } catch (error) {
        this.logger.warn(
          `Snapshot diario del curso ${String(event._id)} falló: ${(error as Error).message}`,
        );
      }
    }
    this.logger.log(`Snapshots diarios ${snapshotDate}: ${courses} cursos`);
    return { courses };
  }

  async getDaily(
    organizationId: string,
    eventId: string,
    from?: string,
    to?: string,
  ) {
    const dateFilter: Record<string, string> = {};
    if (from) dateFilter.$gte = from;
    if (to) dateFilter.$lte = to;
    return this.snapshotModel
      .find({
        organization_id: organizationId,
        event_id: eventId,
        kind: 'daily',
        ...(from || to ? { snapshot_date: dateFilter } : {}),
      })
      .sort({ snapshot_date: 1 })
      .lean()
      .exec();
  }

  // ───────────────────────── Cálculo ─────────────────────────

  private async findOrgEvents(organizationId: string): Promise<EventRef[]> {
    return (await this.eventModel.collection
      .find(
        { organizer_id: { $in: idVariants(organizationId) } },
        { projection: { name: 1, organizer_id: 1 } },
      )
      .toArray()) as unknown as EventRef[];
  }

  private async findEventsWithEnrollments(): Promise<EventRef[]> {
    const ids: any[] =
      await this.courseAttendeeModel.collection.distinct('event_id');
    const objectIds = Array.from(new Set(ids.map((id) => String(id))))
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    return (await this.eventModel.collection
      .find(
        { _id: { $in: objectIds } },
        { projection: { name: 1, organizer_id: 1 } },
      )
      .toArray()) as unknown as EventRef[];
  }

  /**
   * Estado de cada inscrito y los indicadores agregados de un curso.
   *
   * - Inscrito: tiene registro en courseattendees (agrupado por usuario, la
   *   data tiene duplicados string/ObjectId).
   * - Completado: progreso del curso >= 100.
   * - Última actividad en el curso: lo más reciente entre su registro en
   *   activityattendees y el tiempo rastreado en useractivities para este
   *   curso. No cuenta el inicio de sesión (useractivities.last_updated),
   *   que cambia aunque el usuario no estudie.
   * - Activo / inactivo / nunca activo: solo entre los no completados, según
   *   si su última actividad está dentro de los últimos INACTIVE_DAYS días.
   * - Fecha de finalización: completed_at si se midió; si no, se estima con
   *   lo más temprano entre el certificado emitido y la última actividad
   *   llevada al 100% (ambos ocurren en o después de la finalización real,
   *   así que es una cota superior).
   */
  async computeEvent(
    event: EventRef,
    organizationId: string,
    now: Date,
  ): Promise<{ metrics: CourseSnapshotMetrics; rows: UserRow[] }> {
    const eventId = String(event._id);
    const eventVals = idVariants(eventId);

    const activities = await this.activityModel.collection
      .find({ event_id: { $in: eventVals } }, { projection: { _id: 1 } })
      .toArray();
    const activityVals = activities.flatMap((a: any) => idVariants(a._id));
    const activityCount = activities.length;

    const [attendees, activityRows, courseTime, activityTime, certificates] =
      await Promise.all([
        this.courseAttendeeModel.collection
          .aggregate([
            { $match: { event_id: { $in: eventVals } } },
            {
              $group: {
                _id: { $toString: '$user_id' },
                progress: { $max: { $ifNull: ['$progress', 0] } },
                enrolled_at: { $min: '$createdAt' },
                completed_at: { $min: '$completed_at' },
              },
            },
          ])
          .toArray(),
        activityVals.length
          ? this.activityAttendeeModel.collection
              .aggregate([
                { $match: { activity_id: { $in: activityVals } } },
                {
                  $group: {
                    _id: {
                      user: { $toString: '$user_id' },
                      activity: { $toString: '$activity_id' },
                    },
                    progress: { $max: { $ifNull: ['$progress', 0] } },
                    last_at: { $max: '$updatedAt' },
                    completed_at: {
                      $max: {
                        $cond: [
                          { $gte: ['$progress', 100] },
                          '$updatedAt',
                          null,
                        ],
                      },
                    },
                  },
                },
                {
                  $group: {
                    _id: '$_id.user',
                    progress_sum: { $sum: { $min: ['$progress', 100] } },
                    last_at: { $max: '$last_at' },
                    last_completed_at: { $max: '$completed_at' },
                  },
                },
              ])
              .toArray()
          : Promise.resolve([] as any[]),
        // useractivities guarda event_id como string dentro de los arrays
        this.userActivityModel.collection
          .aggregate([
            { $match: { 'courses.event_id': eventId } },
            { $unwind: '$courses' },
            { $match: { 'courses.event_id': eventId } },
            {
              $group: {
                _id: { $toString: '$user_id' },
                time_ms: { $sum: { $ifNull: ['$courses.time_spent_ms', 0] } },
                last_at: { $max: '$courses.last_updated' },
              },
            },
          ])
          .toArray(),
        this.userActivityModel.collection
          .aggregate([
            { $match: { 'activities.event_id': eventId } },
            { $unwind: '$activities' },
            { $match: { 'activities.event_id': eventId } },
            {
              $group: {
                _id: { $toString: '$user_id' },
                last_at: { $max: '$activities.last_updated' },
              },
            },
          ])
          .toArray(),
        this.certificateModel.collection
          .aggregate([
            {
              $match: {
                eventId: { $in: eventVals },
                status: 'COMPLETED',
                userId: { $ne: null },
              },
            },
            {
              $group: {
                _id: { $toString: '$userId' },
                at: { $min: { $ifNull: ['$generatedAt', '$createdAt'] } },
              },
            },
          ])
          .toArray(),
      ]);

    const activityByUser = new Map(
      activityRows.map((r: any) => [String(r._id), r]),
    );
    const courseTimeByUser = new Map(
      courseTime.map((r: any) => [String(r._id), r]),
    );
    const activityTimeByUser = new Map(
      activityTime.map((r: any) => [String(r._id), r]),
    );
    const certificateByUser = new Map(
      certificates.map((r: any) => [String(r._id), r.at as Date]),
    );

    // Contacto (teléfono + consentimiento) desde la membresía de la
    // organización. El campo de consentimiento solo puede ser un nombre
    // simple: va interpolado en la proyección.
    const org = Types.ObjectId.isValid(organizationId)
      ? await this.organizationModel.collection.findOne(
          { _id: new Types.ObjectId(organizationId) },
          { projection: { whatsapp_consent_property: 1 } },
        )
      : null;
    const consentProperty = /^\w+$/.test(
      String(org?.whatsapp_consent_property || ''),
    )
      ? String(org!.whatsapp_consent_property)
      : null;
    const userVals = attendees.flatMap((a: any) => idVariants(String(a._id)));
    const orgUsers = userVals.length
      ? await this.organizationUserModel.collection
          .find(
            {
              organization_id: { $in: idVariants(organizationId) },
              user_id: { $in: userVals },
            },
            {
              projection: {
                user_id: 1,
                whatsapp_opt_in: 1,
                whatsapp_opt_out_at: 1,
                'properties.phone': 1,
                'properties.indicativodepais': 1,
                ...(consentProperty
                  ? { [`properties.${consentProperty}`]: 1 }
                  : {}),
              },
            },
          )
          .toArray()
      : [];
    const orgUserById = new Map(
      orgUsers.map((o: any) => [String(o.user_id), o]),
    );

    const rows: UserRow[] = attendees.map((a: any) => {
      const userId = String(a._id);
      const act = activityByUser.get(userId);
      const ct = courseTimeByUser.get(userId);
      const at = activityTimeByUser.get(userId);
      const orgUser: any = orgUserById.get(userId) || null;

      const courseProgress = Math.min(Number(a.progress) || 0, 100);
      const activityProgress =
        activityCount > 0 && act ? (act.progress_sum || 0) / activityCount : 0;
      const lastActivityAt = maxDate(act?.last_at, ct?.last_at, at?.last_at);
      const daysInactive = lastActivityAt
        ? Math.floor((now.getTime() - lastActivityAt.getTime()) / DAY_MS)
        : null;
      const completed = courseProgress >= 100;

      let status: CourseUserStatus;
      if (completed) status = 'completed';
      else if (daysInactive === null) status = 'never_active';
      else if (daysInactive <= INACTIVE_DAYS) status = 'active';
      else status = 'inactive';

      let completedAt: Date | null = null;
      let completedAtSource: CompletedAtSource = null;
      if (completed) {
        if (a.completed_at) {
          completedAt = new Date(a.completed_at);
          completedAtSource = 'tracked';
        } else {
          completedAt = minDate(
            certificateByUser.get(userId),
            act?.last_completed_at,
          );
          completedAtSource = completedAt ? 'estimated' : null;
        }
      }

      return {
        user_id: userId,
        enrolled_at: a.enrolled_at ? new Date(a.enrolled_at) : null,
        course_progress: courseProgress,
        activity_progress: round1(activityProgress),
        status,
        last_activity_at: lastActivityAt,
        days_inactive: daysInactive,
        time_spent_ms: Number(ct?.time_ms) || 0,
        completed_at: completedAt,
        completed_at_source: completedAtSource,
        has_phone: Boolean(orgUser && resolvePhone(orgUser, null)),
        whatsapp_opt_in: hasWhatsappConsent(orgUser, consentProperty),
      };
    });

    return { metrics: this.summarize(rows, now), rows };
  }

  private summarize(rows: UserRow[], now: Date): CourseSnapshotMetrics {
    const enrolled = rows.length;
    const notCompleted = rows.filter((r) => r.status !== 'completed');
    const completedRows = rows.filter((r) => r.status === 'completed');
    const activeWithin = (days: number) =>
      notCompleted.filter(
        (r) => r.days_inactive !== null && r.days_inactive <= days,
      ).length;

    const byMonth = new Map<string, number>();
    const durations: number[] = [];
    let completionsLast30d = 0;
    for (const r of completedRows) {
      if (!r.completed_at) continue;
      const month = localDate(r.completed_at).slice(0, 7);
      byMonth.set(month, (byMonth.get(month) || 0) + 1);
      if (now.getTime() - r.completed_at.getTime() <= 30 * DAY_MS) {
        completionsLast30d++;
      }
      if (r.enrolled_at) {
        const days =
          (r.completed_at.getTime() - r.enrolled_at.getTime()) / DAY_MS;
        if (days >= 0) durations.push(days);
      }
    }
    durations.sort((a, b) => a - b);
    const median = durations.length
      ? durations.length % 2
        ? durations[(durations.length - 1) / 2]
        : (durations[durations.length / 2 - 1] +
            durations[durations.length / 2]) /
          2
      : null;

    const sum = (fn: (r: UserRow) => number) =>
      rows.reduce((acc, r) => acc + fn(r), 0);

    return {
      enrolled,
      completed: completedRows.length,
      completion_rate: enrolled
        ? round1((completedRows.length / enrolled) * 100)
        : 0,
      in_progress: notCompleted.filter((r) => r.course_progress > 0).length,
      not_started: notCompleted.filter((r) => r.course_progress <= 0).length,
      active_7d: activeWithin(7),
      active_15d: activeWithin(INACTIVE_DAYS),
      active_30d: activeWithin(30),
      inactive_15d: notCompleted.filter((r) => r.status === 'inactive').length,
      never_active: notCompleted.filter((r) => r.status === 'never_active')
        .length,
      avg_course_progress: enrolled
        ? round1(sum((r) => r.course_progress) / enrolled)
        : 0,
      avg_activity_progress: enrolled
        ? round1(sum((r) => r.activity_progress) / enrolled)
        : 0,
      total_time_ms: sum((r) => r.time_spent_ms),
      users_with_time: rows.filter((r) => r.time_spent_ms > 0).length,
      completed_tracked: completedRows.filter(
        (r) => r.completed_at_source === 'tracked',
      ).length,
      completed_estimated: completedRows.filter(
        (r) => r.completed_at_source === 'estimated',
      ).length,
      completed_unknown_date: completedRows.filter((r) => !r.completed_at)
        .length,
      completions_last_30d: completionsLast30d,
      completions_by_month: Array.from(byMonth.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, count]) => ({ month, count })),
      days_to_complete_avg: durations.length
        ? round1(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null,
      days_to_complete_median: median === null ? null : round1(median),
      days_to_complete_sample: durations.length,
      with_phone: rows.filter((r) => r.has_phone).length,
      not_completed_with_phone: notCompleted.filter((r) => r.has_phone).length,
      with_whatsapp_opt_in: rows.filter((r) => r.whatsapp_opt_in).length,
      reachable_not_completed: notCompleted.filter(
        (r) => r.has_phone && r.whatsapp_opt_in,
      ).length,
    };
  }
}
