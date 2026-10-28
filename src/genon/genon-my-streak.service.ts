import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Event } from 'src/events/schemas/event.schema';
import { User } from 'src/users/schemas/user.schema';
import { ProgressEventsService } from 'src/progress-events/progress-events.service';
import { GenOnProgram } from './schemas/genon-program.schema';
import { GenOnEnrollment } from './schemas/genon-enrollment.schema';
import { GenOnTriggersService, milestoneDedupe } from './genon-triggers.service';
import { withTriggerDefaults } from './genon-defaults';
import { localDate, zonedTime } from './genon-schedule';
import {
  addDays,
  daysToBridge,
  medalFor,
  nextMedal,
  StreakMedal,
  streakState,
} from './genon-streak';

// Días de la racha que se detallan en la plataforma
const MAX_DETAIL_DAYS = 30;
// Celebraciones vistas que se recuerdan por inscripción
const SEEN_KEEP = 30;

/**
 * safe: hoy ya cuenta · protected: hoy aún no estudia, pero un protector
 * cubre el día · at_risk: hoy aún no estudia · broken: se cortó (quizá
 * recuperable) · none: sin racha
 */
export type MyStreakStatus = 'none' | 'safe' | 'protected' | 'at_risk' | 'broken';

export interface MyStreak {
  /** Inscripción donde se guardan los logros vistos */
  enrollment_id: string;
  event_id: string;
  /** Cursos del programa: en cualquiera de ellos se suma a la racha */
  event_ids: string[];
  /** Cursos de la persona en el programa */
  event_name: string;
  organization_id: string;
  /** Zona del programa (los días de la racha son de esta zona) */
  timezone: string;
  today: string;
  current: number;
  best: number;
  active_today: boolean;
  /** Actividades terminadas hoy (en todos sus cursos) */
  today_activities: number;
  /** Día en que empezó la racha viva */
  start: string | null;
  status: MyStreakStatus;
  /** Hasta cuándo hay que estudiar para no perderla (fin del día, hora local) */
  deadline: string | null;
  medal: StreakMedal | null;
  next_medal: (StreakMedal & { missing: number }) | null;
  milestones: number[];
  /** Protector de racha: un día con varias actividades cubre un día sin estudio */
  shield: {
    enabled: boolean;
    min_activities: number;
    max: number;
    /** Guardados */
    count: number;
    earned_today: boolean;
  };
  /** Mostrar el botón de examen en la ventana de actividad completada */
  practice_button: boolean;
  /**
   * Por qué la tiene: qué hizo cada día de la racha (el más reciente
   * primero). `covered`: día sin estudio que no cortó la racha (reto de
   * recuperación o protector).
   */
  days: {
    day: string;
    activities: number;
    challenges: number;
    covered: 'challenge' | 'shield' | null;
  }[];
  /** Racha cortada que un reto de repaso por WhatsApp aún puede recuperar */
  recovery: { lost: number; until: string } | null;
  /** Le llegan los mensajes de Gen.ON por WhatsApp (reconocimiento, retos) */
  whatsapp: boolean;
  /** Logro de hoy que la plataforma aún no le mostró */
  celebrate: { key: string; kind: 'milestone' | 'day'; days: number; medal: StreakMedal | null } | null;
}

/**
 * La racha vista por el estudiante (perfil, encabezado y aviso al lograrla)
 * y su reacción inmediata: al terminar una actividad, la racha se actualiza
 * y, si llega a un hito, el reconocimiento sale ya por WhatsApp. La racha es
 * de la persona en el programa: cuentan todos sus cursos.
 */
@Injectable()
export class GenOnMyStreakService implements OnModuleInit {
  private readonly logger = new Logger(GenOnMyStreakService.name);

  constructor(
    @InjectModel(GenOnProgram.name)
    private readonly programModel: Model<GenOnProgram>,
    @InjectModel(GenOnEnrollment.name)
    private readonly enrollmentModel: Model<GenOnEnrollment>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    private readonly progressEvents: ProgressEventsService,
    private readonly triggers: GenOnTriggersService,
  ) {}

  onModuleInit() {
    this.progressEvents.onActivityCompleted(({ userId, eventId }) =>
      this.onStudied(userId, eventId),
    );
  }

  /** Terminó una actividad: racha al día y reconocimiento si llegó a un hito. */
  async onStudied(userId: string, eventId: string, now = new Date()) {
    for (const { program, enrollments } of await this.streakPrograms({ user_id: userId })) {
      try {
        if (!(await this.triggers.programEventIds(program)).includes(eventId)) continue;
        const e = enrollments.find((x) => x.event_id === eventId) || enrollments[0];
        const { state, outcome } = await this.triggers.streakMilestoneNow(program, e, now);
        if (outcome) {
          this.logger.log(
            `Gen.ON "${program.name}": racha de ${state.current} días de ${userId} → ${outcome.result}` +
              (outcome.reason ? ` (${outcome.reason})` : ''),
          );
        }
      } catch (error) {
        this.logger.warn(
          `Gen.ON: no se pudo actualizar la racha de ${userId}: ${(error as Error).message}`,
        );
      }
    }
  }

  /** Rachas del usuario de la sesión, una por programa (opcionalmente de una organización o curso). */
  async mine(
    uid: string,
    filter: { organizationId?: string; eventId?: string },
  ): Promise<MyStreak[]> {
    const userId = await this.userIdOf(uid);
    if (!userId) return [];
    const groups = await this.streakPrograms({
      user_id: userId,
      ...(filter.organizationId ? { organization_id: filter.organizationId } : {}),
    });

    const eventIds = [...new Set(groups.flatMap((g) => g.enrollments.map((e) => e.event_id)))].filter(
      (id) => Types.ObjectId.isValid(id),
    );
    const events = await this.eventModel.collection
      .find(
        { _id: { $in: eventIds.map((id) => new Types.ObjectId(id)) } },
        { projection: { name: 1 } },
      )
      .toArray();
    const names = new Map(events.map((ev: any) => [String(ev._id), String(ev.name || 'Curso')]));

    const now = new Date();
    const out: MyStreak[] = [];
    for (const { program, enrollments } of groups) {
      const programEvents = await this.triggers.programEventIds(program);
      if (filter.eventId && !programEvents.includes(filter.eventId)) continue;
      out.push(await this.view(program, userId, enrollments, programEvents, names, now));
    }
    return out.sort((a, b) => b.current - a.current || b.best - a.best);
  }

  /** La plataforma ya le mostró el logro (no se repite). */
  async markSeen(uid: string, enrollmentId: string, key: string) {
    const userId = await this.userIdOf(uid);
    if (!userId || !Types.ObjectId.isValid(enrollmentId) || !key) {
      throw new NotFoundException('Racha no encontrada');
    }
    const res = await this.enrollmentModel
      .updateOne(
        { _id: new Types.ObjectId(enrollmentId), user_id: userId, test: false },
        { $push: { streak_seen: { $each: [String(key)], $slice: -SEEN_KEEP } } },
      )
      .exec();
    if (!res.matchedCount) throw new NotFoundException('Racha no encontrada');
    return { ok: true };
  }

  async view(
    program: GenOnProgram,
    userId: string,
    enrollments: GenOnEnrollment[],
    programEvents: string[],
    names: Map<string, string>,
    now: Date,
  ): Promise<MyStreak> {
    const cfg = withTriggerDefaults(program.triggers).streak;
    const tz = program.timezone;
    const today = localDate(now, tz);
    const person = await this.triggers.personStreak(program, userId, now);
    const s = person.state;
    const studied = person.days;
    const covered = [...person.bridged, ...person.shielded];
    const milestones = [...new Set(cfg.milestones)].sort((a, b) => a - b);
    const holder = person.lead || enrollments[0];

    const days: MyStreak['days'] = [];
    if (s.start) {
      let d = s.activeToday ? today : addDays(today, -1);
      while (d >= s.start && days.length < MAX_DETAIL_DAYS) {
        const entry = studied.get(d);
        days.push({
          day: d,
          activities: entry?.activities || 0,
          challenges: entry?.challenges || 0,
          covered: entry ? null : person.shielded.has(d) ? 'shield' : 'challenge',
        });
        d = addDays(d, -1);
      }
    }

    // Lo que un reto de repaso puede recuperar (misma regla que la conversación)
    let recovery: MyStreak['recovery'] = null;
    const before = [...studied.keys()].filter((d) => d < today);
    const gap = daysToBridge(before, covered, today, cfg.recovery_window_days);
    if (cfg.recovery_enabled && gap.length) {
      const lost = streakState(before, [...covered, ...gap], today).throughYesterday;
      const lastValid = before.sort().pop();
      if (lost >= cfg.recovery_min && lastValid) {
        recovery = { lost, until: addDays(lastValid, cfg.recovery_window_days + 1) };
      }
    }

    const status: MyStreakStatus = s.activeToday
      ? 'safe'
      : s.current > 0
        ? person.shields > 0
          ? 'protected'
          : 'at_risk'
        : recovery
          ? 'broken'
          : 'none';
    // Con protector, si hoy no estudia el protector cubre hoy: el plazo es mañana
    const deadline =
      status === 'safe' || status === 'protected'
        ? zonedTime(addDays(today, 1), '23:59', tz)
        : status === 'at_risk'
          ? zonedTime(today, '23:59', tz)
          : null;

    let celebrate: MyStreak['celebrate'] = null;
    if (s.activeToday && s.start) {
      const milestone = milestones.includes(s.current);
      // Un aviso por día de la racha (inicio + días), no por fecha: así el
      // laboratorio (que corre las fechas hacia atrás) también lo muestra
      const key = milestone ? milestoneDedupe(s.start, s.current) : `day:${s.start}:${s.current}`;
      if (!person.seen.has(key)) {
        celebrate = {
          key,
          kind: milestone ? 'milestone' : 'day',
          days: s.current,
          medal: medalFor(s.current, milestones),
        };
      }
    }

    const courseNames = [...new Set(enrollments.map((e) => names.get(e.event_id) || 'Curso'))];
    return {
      enrollment_id: String(holder._id),
      event_id: holder.event_id,
      event_ids: programEvents,
      event_name: courseNames.length > 2 ? 'tus cursos' : courseNames.join(' y '),
      organization_id: holder.organization_id,
      timezone: tz,
      today,
      current: s.current,
      best: person.best,
      active_today: s.activeToday,
      today_activities: studied.get(today)?.activities || 0,
      start: s.start,
      status,
      deadline: deadline ? deadline.toISOString() : null,
      medal: medalFor(s.current, milestones),
      next_medal: nextMedal(s.current, milestones),
      milestones,
      shield: {
        enabled: cfg.shield_enabled,
        min_activities: cfg.shield_min_activities,
        max: cfg.shield_max,
        count: person.shields,
        earned_today: person.shieldEarnedToday,
      },
      practice_button: !!cfg.practice_button,
      days,
      recovery,
      whatsapp: program.mode === 'live' && !holder.exited && !holder.holdout,
      celebrate,
    };
  }

  /** Inscripciones reales del usuario, por programa en marcha con la racha encendida. */
  private async streakPrograms(filter: Record<string, string>) {
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
      .filter((p) => withTriggerDefaults(p.triggers).streak.enabled)
      .map((program) => ({
        program,
        enrollments: enrollments.filter((e) => e.program_id === String(program._id)),
      }));
  }

  private async userIdOf(uid: string): Promise<string | null> {
    const user = await this.userModel.collection.findOne(
      { uid: String(uid) },
      { projection: { _id: 1 } },
    );
    return user ? String(user._id) : null;
  }
}
