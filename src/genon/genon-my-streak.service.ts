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

export type MyStreakStatus = 'none' | 'safe' | 'at_risk' | 'broken';

export interface MyStreak {
  enrollment_id: string;
  event_id: string;
  event_name: string;
  organization_id: string;
  /** Zona del programa (los días de la racha son de esta zona) */
  timezone: string;
  today: string;
  current: number;
  best: number;
  active_today: boolean;
  /** Día en que empezó la racha viva */
  start: string | null;
  /**
   * safe: hoy ya cuenta · at_risk: hoy aún no estudia · broken: se cortó
   * (quizá recuperable) · none: sin racha
   */
  status: MyStreakStatus;
  /** Hasta cuándo hay que estudiar para no perderla (fin del día, hora local) */
  deadline: string | null;
  medal: StreakMedal | null;
  next_medal: (StreakMedal & { missing: number }) | null;
  milestones: number[];
  /** Por qué la tiene: qué hizo cada día de la racha (el más reciente primero) */
  days: { day: string; activities: number; challenges: number; recovered: boolean }[];
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
 * y, si llega a un hito, el reconocimiento sale ya por WhatsApp.
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

  /** Terminó una actividad o superó un reto: racha al día y reconocimiento si llegó a un hito. */
  async onStudied(userId: string, eventId: string, now = new Date()) {
    for (const { program, e } of await this.streakEnrollments({
      user_id: userId,
      event_id: eventId,
    })) {
      try {
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

  /** Rachas del usuario de la sesión, por curso (opcionalmente de una organización o curso). */
  async mine(
    uid: string,
    filter: { organizationId?: string; eventId?: string },
  ): Promise<MyStreak[]> {
    const userId = await this.userIdOf(uid);
    if (!userId) return [];
    const pairs = await this.streakEnrollments({
      user_id: userId,
      ...(filter.organizationId ? { organization_id: filter.organizationId } : {}),
      ...(filter.eventId ? { event_id: filter.eventId } : {}),
    });
    // Un curso en dos programas: cuenta el primero
    const byEvent = new Map<string, (typeof pairs)[number]>();
    for (const p of pairs) if (!byEvent.has(p.e.event_id)) byEvent.set(p.e.event_id, p);

    const eventIds = [...byEvent.keys()].filter((id) => Types.ObjectId.isValid(id));
    const events = await this.eventModel.collection
      .find(
        { _id: { $in: eventIds.map((id) => new Types.ObjectId(id)) } },
        { projection: { name: 1 } },
      )
      .toArray();
    const names = new Map(events.map((ev: any) => [String(ev._id), String(ev.name || 'Curso')]));

    const now = new Date();
    const out: MyStreak[] = [];
    for (const { program, e } of byEvent.values()) {
      out.push(await this.view(program, e, names.get(e.event_id) || 'Curso', now));
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
    e: GenOnEnrollment,
    eventName: string,
    now: Date,
  ): Promise<MyStreak> {
    const cfg = withTriggerDefaults(program.triggers).streak;
    const tz = program.timezone;
    const today = localDate(now, tz);
    const studied = await this.triggers.studyDays(program, e, now);
    const bridged = e.streak_bridged || [];
    const s = streakState(studied.keys(), bridged, today);
    const milestones = [...new Set(cfg.milestones)].sort((a, b) => a - b);

    const days: MyStreak['days'] = [];
    if (s.start) {
      let d = s.activeToday ? today : addDays(today, -1);
      while (d >= s.start && days.length < MAX_DETAIL_DAYS) {
        const entry = studied.get(d);
        days.push({
          day: d,
          activities: entry?.activities || 0,
          challenges: entry?.challenges || 0,
          recovered: !entry,
        });
        d = addDays(d, -1);
      }
    }

    // Lo que un reto de repaso puede recuperar (misma regla que la conversación)
    let recovery: MyStreak['recovery'] = null;
    const before = [...studied.keys()].filter((d) => d < today);
    const gap = daysToBridge(before, bridged, today, cfg.recovery_window_days);
    if (cfg.recovery_enabled && gap.length) {
      const lost = streakState(before, [...bridged, ...gap], today).throughYesterday;
      const lastValid = before.sort().pop();
      if (lost >= cfg.recovery_min && lastValid) {
        recovery = { lost, until: addDays(lastValid, cfg.recovery_window_days + 1) };
      }
    }

    const status: MyStreakStatus = s.activeToday
      ? 'safe'
      : s.current > 0
        ? 'at_risk'
        : recovery
          ? 'broken'
          : 'none';
    const deadline =
      status === 'safe'
        ? zonedTime(addDays(today, 1), '23:59', tz)
        : status === 'at_risk'
          ? zonedTime(today, '23:59', tz)
          : null;

    const seen = new Set(e.streak_seen || []);
    let celebrate: MyStreak['celebrate'] = null;
    if (s.activeToday && s.start) {
      const milestone = milestones.includes(s.current);
      const key = milestone ? milestoneDedupe(s.start, s.current) : `day:${today}`;
      if (!seen.has(key)) {
        celebrate = {
          key,
          kind: milestone ? 'milestone' : 'day',
          days: s.current,
          medal: medalFor(s.current, milestones),
        };
      }
    }

    return {
      enrollment_id: String(e._id),
      event_id: e.event_id,
      event_name: eventName,
      organization_id: e.organization_id,
      timezone: tz,
      today,
      current: s.current,
      best: Math.max(e.streak?.best || 0, s.current),
      active_today: s.activeToday,
      start: s.start,
      status,
      deadline: deadline ? deadline.toISOString() : null,
      medal: medalFor(s.current, milestones),
      next_medal: nextMedal(s.current, milestones),
      milestones,
      days,
      recovery,
      whatsapp: program.mode === 'live' && !e.exited && !e.holdout,
      celebrate,
    };
  }

  /** Inscripciones reales con la racha encendida en un programa en marcha. */
  private async streakEnrollments(filter: Record<string, string>) {
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
    const byId = new Map(
      programs
        .filter((p) => withTriggerDefaults(p.triggers).streak.enabled)
        .map((p) => [String(p._id), p]),
    );
    return enrollments
      .filter((e) => byId.has(e.program_id))
      .map((e) => ({ program: byId.get(e.program_id)!, e }));
  }

  private async userIdOf(uid: string): Promise<string | null> {
    const user = await this.userModel.collection.findOne(
      { uid: String(uid) },
      { projection: { _id: 1 } },
    );
    return user ? String(user._id) : null;
  }
}
