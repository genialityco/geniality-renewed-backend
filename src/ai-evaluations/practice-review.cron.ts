import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Event } from 'src/events/schemas/event.schema';
import { ActivityAttendee } from 'src/activity-attendee/schemas/activity-attendee.schema';
import {
  PRACTICE_ACTIVE_STATUSES,
  PracticeSession,
} from './schemas/practice-session.schema';
import { PracticeSessionsService } from './practice-sessions.service';
import { idVariants } from './course-content.service';
import { isWithinSchedule, normalizeSchedule } from './review-schedule';

const DAY_MS = 86400000;
const MIN_PROGRESS = Number(process.env.PRACTICE_MIN_PROGRESS) || 100;
// Al activar el repaso no se escribe a quien completó actividades hace meses
const LOOKBACK_DAYS = 30;
// Si ignoró o rechazó los dos últimos repasos, se pausa este tiempo
const PAUSE_DAYS = 30;
// Envíos máximos por ejecución (cada 15 min), para no saturar el gateway
const MAX_SENDS_PER_TICK = 40;
// Sesiones invitadas/en curso sin actividad en este tiempo se dan por vencidas
const SESSION_TTL_DAYS = Number(process.env.PRACTICE_SESSION_TTL_DAYS) || 7;

/**
 * Repaso automático por WhatsApp (repetición espaciada): en los cursos con
 * `whatsapp_review_enabled`, envía un simulacro de 3-4 preguntas no vistas a
 * quien completó actividades hace `whatsapp_review_delay_days` días, solo
 * dentro de las franjas de envío y fuera de las de descanso del curso.
 *
 * Reglas: opt-in y teléfono; como máximo un repaso cada `delay` días por
 * curso y solo si completó algo nuevo desde el anterior; nunca con un
 * simulacro activo; se pausa si ignoró los dos últimos.
 *
 * Solo corre con PRACTICE_REVIEW_CRON_ENABLED=true, para que un backend
 * local conectado a la base de producción no envíe mensajes reales. Asume
 * una sola instancia (igual que WhatsappInboundService).
 */
@Injectable()
export class PracticeReviewCron {
  private readonly logger = new Logger(PracticeReviewCron.name);
  private running = false;
  // usuario:curso sin nada que enviar → no se reintenta hasta esa hora
  private readonly skipUntil = new Map<string, number>();

  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(ActivityAttendee.name)
    private readonly attendeeModel: Model<ActivityAttendee>,
    @InjectModel(PracticeSession.name)
    private readonly sessionModel: Model<PracticeSession>,
    private readonly practice: PracticeSessionsService,
  ) {}

  @Cron('0 */15 * * * *')
  async tick() {
    if (process.env.PRACTICE_REVIEW_CRON_ENABLED !== 'true') return;
    if (this.running) return;
    this.running = true;
    try {
      await this.run(new Date());
    } catch (error) {
      this.logger.error(`Repaso automático: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async run(now: Date) {
    const nowMs = now.getTime();
    for (const [key, until] of this.skipUntil) {
      if (until <= nowMs) this.skipUntil.delete(key);
    }

    // Vence simulacros abandonados para que no bloqueen los siguientes
    await this.sessionModel
      .updateMany(
        {
          status: { $in: PRACTICE_ACTIVE_STATUSES },
          updated_at: { $lt: new Date(nowMs - SESSION_TTL_DAYS * DAY_MS) },
        },
        { $set: { status: 'expired', finished_at: now } },
      )
      .exec();

    const events = await this.eventModel
      .find({ whatsapp_review_enabled: true })
      .select(
        'name organizer_id whatsapp_review_delay_days whatsapp_review_timezone whatsapp_review_days whatsapp_review_windows whatsapp_review_rest_windows',
      )
      .lean()
      .exec();

    let budget = MAX_SENDS_PER_TICK;
    let sent = 0;
    for (const event of events) {
      if (budget <= 0) break;
      const schedule = normalizeSchedule(event);
      if (!isWithinSchedule(now, schedule)) continue;

      const delayMs = schedule.delayDays * DAY_MS;
      const cutoff = new Date(nowMs - delayMs);
      const lookback = new Date(cutoff.getTime() - LOOKBACK_DAYS * DAY_MS);
      const eventId = String(event._id);

      // Estudiantes con actividades completadas hace al menos `delay` días
      const candidates = await this.attendeeModel
        .aggregate<{ _id: unknown; last_completed: Date }>([
          {
            $match: {
              event_id: { $in: idVariants(eventId) },
              progress: { $gte: MIN_PROGRESS },
              updatedAt: { $gt: lookback, $lte: cutoff },
            },
          },
          {
            $group: { _id: '$user_id', last_completed: { $max: '$updatedAt' } },
          },
        ])
        .exec();

      for (const c of candidates) {
        if (budget <= 0) break;
        const key = `${String(c._id)}:${eventId}`;
        if ((this.skipUntil.get(key) || 0) > nowMs) continue;

        const userIds = idVariants(c._id);
        const recent = await this.sessionModel
          .find({
            user_id: { $in: userIds },
            event_id: event._id,
            trigger: 'auto',
          })
          .sort({ invited_at: -1 })
          .limit(2)
          .select('invited_at started_at status material_until')
          .lean()
          .exec();
        const last = recent[0];
        if (last) {
          // Como máximo un repaso cada `delay` días por curso
          if (nowMs - new Date(last.invited_at).getTime() < delayMs) continue;
          // Solo si completó algo después del material del repaso anterior
          if (
            last.material_until &&
            new Date(c.last_completed) <= new Date(last.material_until)
          )
            continue;
        }
        const ignored = (s: (typeof recent)[number]) =>
          !s.started_at && !PRACTICE_ACTIVE_STATUSES.includes(s.status);
        if (
          recent.length === 2 &&
          recent.every(ignored) &&
          nowMs - new Date(last.invited_at).getTime() < PAUSE_DAYS * DAY_MS
        ) {
          continue;
        }

        // Una invitación automática sin respuesta tras `delay` días se vence
        // para que el nuevo repaso pueda salir
        await this.sessionModel
          .updateMany(
            {
              user_id: { $in: userIds },
              trigger: 'auto',
              status: { $in: ['invited', 'choosing'] },
              invited_at: { $lt: cutoff },
            },
            { $set: { status: 'expired', finished_at: now } },
          )
          .exec();

        try {
          const result = await this.practice.sendAutoReview({
            organizationId: String(event.organizer_id),
            userId: c._id,
            eventId,
            materialUntil: cutoff,
          });
          if (result.sent) {
            budget--;
            sent++;
          } else {
            this.skipUntil.set(
              key,
              nowMs + (result.reason === 'active_session' ? 1 : 12) * 3600000,
            );
          }
        } catch (error) {
          this.logger.warn(
            `Repaso automático para ${key} falló: ${(error as Error).message}`,
          );
          this.skipUntil.set(key, nowMs + 12 * 3600000);
        }
      }
    }
    if (sent) this.logger.log(`Repasos automáticos enviados: ${sent}`);
  }
}
