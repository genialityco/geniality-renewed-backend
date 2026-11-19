import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ProgressEvent } from 'src/progress-events/schemas/progress-event.schema';
import { EngagementLogService } from 'src/engagement/engagement-log.service';
import { GenOnProgram } from './schemas/genon-program.schema';
import { GenOnEnrollment } from './schemas/genon-enrollment.schema';
import { GenOnEngineService } from './genon-engine.service';
import { localDate, validSlots, zonedTime } from './genon-schedule';
import {
  OUTSIDE_SLOT,
  SLOT_WINDOW_MINUTES,
  SlotEnrollment,
  SlotMessage,
  SlotProgress,
  slotResults,
} from './genon-slot-results';

/** Personas listadas como máximo (las que entraron, avanzaron o se activaron) */
const MAX_PEOPLE = 500;

/**
 * Seguimiento por franja: de los mensajes de un día, cuántas personas que los
 * recibieron entraron al curso, avanzaron o pasaron a activo, frente al grupo
 * de control de esa misma franja, y quiénes fueron. Se mide hasta ahora.
 */
@Injectable()
export class GenOnSlotResultsService {
  constructor(
    @InjectModel(GenOnEnrollment.name)
    private readonly enrollmentModel: Model<GenOnEnrollment>,
    @InjectModel(ProgressEvent.name)
    private readonly progressEventModel: Model<ProgressEvent>,
    private readonly engagementLog: EngagementLogService,
    private readonly engine: GenOnEngineService,
  ) {}

  async forDay(program: GenOnProgram, date: string | undefined, eventId?: string) {
    const timeZone = program.timezone || 'America/Bogota';
    const now = new Date();
    const day = date || localDate(now, timeZone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new BadRequestException('"date" debe tener el formato YYYY-MM-DD');
    }
    const start = zonedTime(day, '00:00', timeZone);
    const nextDay = localDate(new Date(start.getTime() + 36 * 3600 * 1000), timeZone);
    const end = zonedTime(nextDay, '00:00', timeZone);
    const programId = String(program._id);
    const slots = validSlots(program.send_slots);

    let messages = (await this.engagementLog.genonMessagesBetween(
      programId,
      program.organization_ids,
      start,
      end,
    )) as unknown as SlotMessage[];
    if (eventId) messages = messages.filter((m) => m.event_id === eventId);

    const userIds = [...new Set(messages.map((m) => m.user_id))];
    const [enrollments, progress] = userIds.length
      ? await Promise.all([
          this.enrollmentModel
            .find({ program_id: programId, user_id: { $in: userIds }, test: false })
            .select('user_id event_id segment segment_since last_activity_at')
            .lean()
            .exec() as unknown as Promise<SlotEnrollment[]>,
          this.progressEventModel.collection
            .find(
              { user_id: { $in: userIds }, at: { $gte: start } },
              { projection: { user_id: 1, event_id: 1, type: 1, from: 1, to: 1, at: 1 } },
            )
            .toArray() as unknown as Promise<SlotProgress[]>,
        ])
      : [[], []];

    const { summary, people } = slotResults({
      messages,
      enrollments,
      progress,
      slots,
      timeZone,
    });

    const listed = people.slice(0, MAX_PEOPLE);
    const persons = await Promise.all(
      listed.map((p) => this.engine.resolvePerson(p.organization_id, p.user_id)),
    );

    return {
      date: day,
      timezone: timeZone,
      slots,
      outside_slot: OUTSIDE_SLOT,
      slot_window_minutes: SLOT_WINDOW_MINUTES,
      measured_at: now,
      summary,
      people_total: people.length,
      people: listed.map((p, i) => ({
        ...p,
        name: persons[i].name,
        email: persons[i].email,
      })),
    };
  }
}
