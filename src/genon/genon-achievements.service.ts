import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Event } from 'src/events/schemas/event.schema';
import { Activity } from 'src/activities/schemas/activity.schema';
import { ActivityAttendee } from 'src/activity-attendee/schemas/activity-attendee.schema';
import { CourseAttendee } from 'src/course-attendee/schemas/course-attendee.schema';
import { ProgressEvent } from 'src/progress-events/schemas/progress-event.schema';
import { ProgressEventsService } from 'src/progress-events/progress-events.service';
import { User } from 'src/users/schemas/user.schema';
import { GenOnProgram } from './schemas/genon-program.schema';
import { GenOnEnrollment } from './schemas/genon-enrollment.schema';
import { GenOnAchievementAward } from './schemas/genon-achievement-award.schema';
import { GenOnTriggersService } from './genon-triggers.service';
import { formalName } from './genon-context.service';
import { localDate } from './genon-schedule';
import {
  AchievementFacts,
  achievementHoldout,
  achievementProgress,
  achievementText,
  GenOnAchievementDef,
  GenOnAchievementType,
  withAchievementDefaults,
} from './genon-achievements';

// Los cursos y actividades de un programa cambian poco
const CATALOG_TTL_MS = 5 * 60 * 1000;
const RECENT_LIMIT = 50;

function idVariants(id: unknown): any[] {
  const raw = String(id);
  return Types.ObjectId.isValid(raw) && String(new Types.ObjectId(raw)) === raw
    ? [raw, new Types.ObjectId(raw)]
    : [raw];
}

/** Cursos del programa y sus actividades */
interface ProgramCatalog {
  eventIds: string[];
  videoActivityIds: Set<string>;
  modules: Map<string, string[]>;
  courseActivities: Map<string, string[]>;
}

export interface MyAchievementItem {
  id: string;
  type: GenOnAchievementType;
  title: string;
  threshold: number;
  achieved: boolean;
  achieved_at: Date | null;
  /** Avance hacia el umbral (tope: el umbral) */
  progress: number;
  /** Valor actual (actividades, videos, días…) */
  value: number;
  /** Felicitación del logro conseguido */
  text: string | null;
}

export interface MyAchievements {
  program_id: string;
  /** Cursos del programa: en cualquiera se suma */
  event_ids: string[];
  /** Cursos de la persona en el programa ("A y B" o "tus cursos") */
  event_name: string;
  achieved: number;
  total: number;
  items: MyAchievementItem[];
  /** Logros conseguidos que la plataforma aún no le mostró (más antiguo primero) */
  celebrate: { id: string; title: string; text: string }[];
}

/**
 * Logros del estudiante (adaptados de los logros del asistente de
 * gen-live-api): se evalúan al terminar una actividad y cada vez que la
 * plataforma los pide, se otorgan una sola vez por persona y logro y se
 * muestran en un aviso y en «Mis logros». Ninguna llamada desde el avance
 * lanza: un error aquí no puede impedir que se guarde el progreso.
 */
@Injectable()
export class GenOnAchievementsService implements OnModuleInit {
  private readonly logger = new Logger(GenOnAchievementsService.name);
  private readonly catalogs = new Map<string, { at: number; data: ProgramCatalog }>();

  constructor(
    @InjectModel(GenOnProgram.name)
    private readonly programModel: Model<GenOnProgram>,
    @InjectModel(GenOnEnrollment.name)
    private readonly enrollmentModel: Model<GenOnEnrollment>,
    @InjectModel(GenOnAchievementAward.name)
    private readonly awardModel: Model<GenOnAchievementAward>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Activity.name) private readonly activityModel: Model<Activity>,
    @InjectModel(ActivityAttendee.name)
    private readonly attendeeModel: Model<ActivityAttendee>,
    @InjectModel(CourseAttendee.name)
    private readonly courseAttendeeModel: Model<CourseAttendee>,
    @InjectModel(ProgressEvent.name)
    private readonly progressEventModel: Model<ProgressEvent>,
    private readonly progressEvents: ProgressEventsService,
    private readonly triggers: GenOnTriggersService,
  ) {}

  onModuleInit() {
    this.progressEvents.onActivityCompleted(({ userId, eventId }) =>
      this.onStudied(userId, eventId),
    );
  }

  /** Terminó una actividad: otorga los logros que haya cumplido. */
  async onStudied(userId: string, eventId: string, now = new Date()) {
    for (const { program } of await this.programsOf({ user_id: String(userId) })) {
      try {
        const catalog = await this.catalog(program);
        if (!catalog.eventIds.includes(String(eventId))) continue;
        const { fresh } = await this.evaluate(program, String(userId), now);
        if (fresh.length) {
          this.logger.log(
            `Gen.ON "${program.name}": ${userId} consiguió ${fresh.map((a) => a.id).join(', ')}`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `Gen.ON: no se pudieron evaluar los logros de ${userId}: ${(error as Error).message}`,
        );
      }
    }
  }

  // ───────────────────────── Evaluación ─────────────────────────

  /**
   * Avance de la persona en cada tipo de logro y los logros que ya tiene;
   * otorga los que haya cumplido y aún no tenga.
   */
  async evaluate(program: GenOnProgram, userId: string, now = new Date()) {
    const cfg = withAchievementDefaults(program.achievements);
    const items = cfg.items.filter((i) => i.enabled !== false);
    const programId = String(program._id);
    if (!cfg.enabled || !items.length) {
      return { progress: null, awards: [] as GenOnAchievementAward[], fresh: [] as GenOnAchievementDef[] };
    }
    const catalog = await this.catalog(program);
    const facts = await this.facts(program, userId, new Set(items.map((i) => i.type)), catalog, now);
    const progress = achievementProgress(facts);

    const load = () =>
      this.awardModel
        .find({ program_id: programId, user_id: userId })
        .lean<GenOnAchievementAward[]>()
        .exec();
    let awards = await load();
    const have = new Set(awards.map((a) => a.achievement_id));
    const fresh = items.filter((i) => !have.has(i.id) && progress[i.type] >= i.threshold);
    if (fresh.length) {
      const holdout = achievementHoldout(programId, userId, cfg.holdout_percent);
      // Duplicados (otra petición ya lo otorgó) se ignoran por el índice único
      await this.awardModel
        .insertMany(
          fresh.map((i) => ({
            program_id: programId,
            achievement_id: i.id,
            type: i.type,
            threshold: i.threshold,
            user_id: userId,
            value: progress[i.type],
            holdout,
          })),
          { ordered: false },
        )
        .catch((e: any) => {
          if (e?.code !== 11000 && !e?.writeErrors) throw e;
        });
      awards = await load();
    }
    return { progress, awards, fresh };
  }

  /** Lo que hizo la persona en los cursos del programa (solo lo que piden los logros). */
  private async facts(
    program: GenOnProgram,
    userId: string,
    types: Set<GenOnAchievementType>,
    catalog: ProgramCatalog,
    now: Date,
  ): Promise<AchievementFacts> {
    const needs = (...t: GenOnAchievementType[]) => t.some((x) => types.has(x));
    const userVals = idVariants(userId);
    const eventVals = catalog.eventIds.flatMap(idVariants);
    const known = new Set([...catalog.courseActivities.values()].flat());

    const [completed, courses, person, studied, enrollments] = await Promise.all([
      needs('activitiesCompleted', 'videosCompleted', 'modulesCompleted', 'coursesStarted')
        ? this.attendeeModel.collection
            .find(
              { user_id: { $in: userVals }, event_id: { $in: eventVals }, progress: { $gte: 100 } },
              { projection: { activity_id: 1 } },
            )
            .toArray()
        : Promise.resolve([] as any[]),
      needs('coursesCompleted', 'courseProgress')
        ? this.courseAttendeeModel.collection
            .find(
              { user_id: { $in: userVals }, event_id: { $in: eventVals } },
              { projection: { progress: 1 } },
            )
            .toArray()
        : Promise.resolve([] as any[]),
      needs('streakDays')
        ? this.triggers.personStreak(program, userId, now)
        : Promise.resolve(null),
      needs('studyDays')
        ? this.progressEventModel.collection
            .find(
              {
                type: 'activity_progress',
                to: { $gte: 100 },
                user_id: userId,
                event_id: { $in: catalog.eventIds },
              },
              { projection: { at: 1 } },
            )
            .toArray()
        : Promise.resolve([] as any[]),
      needs('studyDays', 'challengesPassed')
        ? this.enrollmentModel
            .find({ program_id: String(program._id), user_id: userId, test: false })
            .select('challenges')
            .lean()
            .exec()
        : Promise.resolve([] as any[]),
    ]);

    const passed = (enrollments as any[]).flatMap((e) =>
      (e.challenges || []).filter((c: any) => c.passed && c.at),
    );
    const days = new Set<string>();
    for (const r of studied as any[]) days.add(localDate(new Date(r.at), program.timezone));
    for (const c of passed) days.add(localDate(new Date(c.at), program.timezone));

    return {
      completedActivityIds: new Set(
        (completed as any[]).map((r) => String(r.activity_id)).filter((id) => known.has(id)),
      ),
      videoActivityIds: catalog.videoActivityIds,
      modules: catalog.modules,
      courseActivities: catalog.courseActivities,
      courseProgress: (courses as any[]).map((c) => Number(c.progress) || 0),
      bestStreak: person?.best || 0,
      studyDays: days.size,
      challengesPassed: passed.length,
    };
  }

  /** Cursos del programa y sus actividades (videos, módulos). */
  private async catalog(program: GenOnProgram): Promise<ProgramCatalog> {
    const key = String(program._id);
    const cached = this.catalogs.get(key);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.data;

    const eventIds = await this.triggers.programEventIds(program);
    const activities = eventIds.length
      ? await this.activityModel.collection
          .find(
            { event_id: { $in: eventIds.flatMap(idVariants) } },
            { projection: { event_id: 1, module_id: 1, is_info_only: 1, 'videos.video_id': 1 } },
          )
          .toArray()
      : [];
    const data: ProgramCatalog = {
      eventIds,
      videoActivityIds: new Set(),
      modules: new Map(),
      courseActivities: new Map(),
    };
    const push = (map: Map<string, string[]>, k: string, v: string) =>
      map.set(k, [...(map.get(k) || []), v]);
    for (const a of activities as any[]) {
      const id = String(a._id);
      push(data.courseActivities, String(a.event_id), id);
      if (a.module_id) push(data.modules, String(a.module_id), id);
      if (!a.is_info_only && Array.isArray(a.videos) && a.videos.length) {
        data.videoActivityIds.add(id);
      }
    }
    this.catalogs.set(key, { at: Date.now(), data });
    return data;
  }

  // ───────────────────────── Vista del estudiante ─────────────────────────

  /**
   * Logros del usuario de la sesión, uno por programa con logros activos
   * (opcionalmente de una organización). No se muestran si el admin no los
   * activó para el estudiante ni a quien cae en el grupo de control (vería
   * sus logros sin la felicitación y contaminaría la medición).
   */
  async mine(uid: string, filter: { organizationId?: string }): Promise<MyAchievements[]> {
    const user = await this.userModel.collection.findOne(
      { uid: String(uid) },
      { projection: { _id: 1, names: 1 } },
    );
    if (!user) return [];
    const userId = String(user._id);
    const nombre = formalName((user as any).names);
    const groups = await this.programsOf({
      user_id: userId,
      ...(filter.organizationId ? { organization_id: filter.organizationId } : {}),
    });

    const eventIds = [...new Set(groups.flatMap((g) => g.enrollments.map((e) => e.event_id)))].filter(
      (id) => Types.ObjectId.isValid(id),
    );
    const events = eventIds.length
      ? await this.eventModel.collection
          .find(
            { _id: { $in: eventIds.map((id) => new Types.ObjectId(id)) } },
            { projection: { name: 1 } },
          )
          .toArray()
      : [];
    const names = new Map(events.map((ev: any) => [String(ev._id), String(ev.name || 'Curso')]));

    const now = new Date();
    const out: MyAchievements[] = [];
    for (const { program, enrollments } of groups) {
      const cfg = withAchievementDefaults(program.achievements);
      const programId = String(program._id);
      if (!cfg.show_to_student || achievementHoldout(programId, userId, cfg.holdout_percent)) {
        continue;
      }
      const { progress, awards } = await this.evaluate(program, userId, now);
      if (!progress) continue;
      const got = new Map(awards.map((a) => [a.achievement_id, a]));
      const items: MyAchievementItem[] = cfg.items
        .filter((i) => i.enabled !== false)
        .map((i) => {
          const a = got.get(i.id);
          const value = a ? Math.max(progress[i.type], a.value) : progress[i.type];
          return {
            id: i.id,
            type: i.type,
            title: i.title,
            threshold: i.threshold,
            achieved: !!a,
            achieved_at: a?.created_at ?? null,
            progress: a ? i.threshold : Math.min(value, i.threshold),
            value,
            text: a ? achievementText(i, nombre, a.value) : null,
          };
        });
      const byId = new Map(items.map((i) => [i.id, i]));
      const celebrate = awards
        .filter((a) => !a.seen_at && byId.has(a.achievement_id))
        .sort((a, b) => new Date(a.created_at!).getTime() - new Date(b.created_at!).getTime())
        .map((a) => {
          const item = byId.get(a.achievement_id)!;
          return { id: item.id, title: item.title, text: item.text! };
        });
      const courseNames = [...new Set(enrollments.map((e) => names.get(e.event_id) || 'Curso'))];
      out.push({
        program_id: programId,
        event_ids: (await this.catalog(program)).eventIds,
        event_name: courseNames.length > 2 ? 'tus cursos' : courseNames.join(' y '),
        achieved: items.filter((i) => i.achieved).length,
        total: items.length,
        items,
        celebrate,
      });
    }
    return out;
  }

  /** La plataforma ya le mostró estos logros (no se repiten). */
  async markSeen(uid: string, programId: string, ids: string[]) {
    const user = await this.userModel.collection.findOne(
      { uid: String(uid) },
      { projection: { _id: 1 } },
    );
    const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean).slice(0, 50);
    if (!user || !programId || !list.length) throw new NotFoundException('Logros no encontrados');
    const res = await this.awardModel
      .updateMany(
        {
          program_id: String(programId),
          user_id: String(user._id),
          achievement_id: { $in: list },
          seen_at: null,
        },
        { $set: { seen_at: new Date() } },
      )
      .exec();
    return { ok: true, updated: res.modifiedCount };
  }

  // ───────────────────────── Informe ─────────────────────────

  /** Cuántos consiguieron cada logro (y cuántos lo vieron) y los más recientes. */
  async report(program: GenOnProgram) {
    const cfg = withAchievementDefaults(program.achievements);
    const programId = String(program._id);
    const rows: {
      _id: string;
      awarded: number;
      holdout: number;
      seen: number;
      first: Date;
      last: Date;
    }[] = await this.awardModel.aggregate([
      { $match: { program_id: programId } },
      {
        $group: {
          _id: '$achievement_id',
          awarded: { $sum: 1 },
          holdout: { $sum: { $cond: ['$holdout', 1, 0] } },
          seen: { $sum: { $cond: [{ $ifNull: ['$seen_at', false] }, 1, 0] } },
          first: { $min: '$created_at' },
          last: { $max: '$created_at' },
        },
      },
    ]);
    const byId = new Map(rows.map((r) => [r._id, r]));
    const recent = await this.awardModel
      .find({ program_id: programId })
      .sort({ created_at: -1 })
      .limit(RECENT_LIMIT)
      .lean<GenOnAchievementAward[]>()
      .exec();
    const userIds = [...new Set(recent.map((r) => r.user_id))].filter((id) =>
      Types.ObjectId.isValid(id),
    );
    const users = userIds.length
      ? await this.userModel.collection
          .find(
            { _id: { $in: userIds.map((id) => new Types.ObjectId(id)) } },
            { projection: { names: 1, email: 1 } },
          )
          .toArray()
      : [];
    const userOf = new Map(users.map((u: any) => [String(u._id), u]));
    const titles = new Map(cfg.items.map((i) => [i.id, i.title]));
    return {
      enabled: cfg.enabled,
      holdout_percent: cfg.holdout_percent,
      achievements: cfg.items.map((i) => {
        const r = byId.get(i.id);
        return {
          id: i.id,
          type: i.type,
          title: i.title,
          threshold: i.threshold,
          enabled: i.enabled !== false,
          awarded: r?.awarded ?? 0,
          holdout: r?.holdout ?? 0,
          seen: r?.seen ?? 0,
          first: r?.first ?? null,
          last: r?.last ?? null,
        };
      }),
      recent: recent.map((r) => ({
        achievement_id: r.achievement_id,
        title: titles.get(r.achievement_id) || r.achievement_id,
        user_id: r.user_id,
        name: String(userOf.get(r.user_id)?.names || ''),
        email: String(userOf.get(r.user_id)?.email || ''),
        value: r.value,
        holdout: r.holdout,
        seen_at: r.seen_at,
        created_at: r.created_at,
      })),
    };
  }

  // ───────────────────────── Apoyo ─────────────────────────

  /** Inscripciones reales del usuario, por programa en marcha con logros activos. */
  private async programsOf(filter: Record<string, string>) {
    const enrollments = await this.enrollmentModel.find({ ...filter, test: false }).exec();
    if (!enrollments.length) return [];
    const programIds = [...new Set(enrollments.map((e) => e.program_id))].filter((id) =>
      Types.ObjectId.isValid(id),
    );
    const programs = await this.programModel
      .find({
        _id: { $in: programIds.map((id) => new Types.ObjectId(id)) },
        mode: { $ne: 'off' },
      })
      .exec();
    return programs
      .filter((p) => withAchievementDefaults(p.achievements).enabled)
      .map((program) => ({
        program,
        enrollments: enrollments.filter((e) => e.program_id === String(program._id)),
      }));
  }
}
