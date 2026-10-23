import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ProgressEvent } from 'src/progress-events/schemas/progress-event.schema';
import { EngagementLogService } from 'src/engagement/engagement-log.service';
import { maskPhone } from 'src/reminders/contact.util';
import { GenOnProgram } from './schemas/genon-program.schema';
import { GenOnEnrollment } from './schemas/genon-enrollment.schema';
import { GenOnFeedback } from './schemas/genon-feedback.schema';
import { GenOnContextService } from './genon-context.service';
import { GenOnEngineService } from './genon-engine.service';
import { localDate } from './genon-schedule';

export type HistoryItem =
  | {
      type: 'message';
      at: Date;
      kind: string;
      step: string | null;
      segment: string | null;
      template: string | null;
      status: string;
      text: string | null;
      progress: number | null;
      completed_activities: number | null;
      delivered_at: Date | null;
      read_at: Date | null;
      clicked_at: Date | null;
      replied_at: Date | null;
      reply_text: string | null;
      opted_out_at: Date | null;
      error: string | null;
    }
  | {
      type: 'activity_progress';
      at: Date;
      activity_id: string;
      activity_name: string;
      from: number;
      to: number;
    }
  | { type: 'course_progress'; at: Date; from: number; to: number }
  | { type: 'course_completed'; at: Date }
  | {
      type: 'challenge';
      at: Date;
      kind: string;
      activity_name: string;
      passed: boolean;
      correct: number;
      total: number;
    }
  | { type: 'feedback'; at: Date; feedback_type: string; text: string };

/**
 * Historial de una persona en un curso del programa: los mensajes que le
 * llegaron (con su avance al enviarlos, entrega, lectura, clic y primera
 * respuesta), su avance en las actividades y el curso, los retos y lo que
 * escribió (soporte, comentarios). Del más reciente al más antiguo.
 */
@Injectable()
export class GenOnHistoryService {
  constructor(
    @InjectModel(GenOnEnrollment.name)
    private readonly enrollmentModel: Model<GenOnEnrollment>,
    @InjectModel(GenOnFeedback.name)
    private readonly feedbackModel: Model<GenOnFeedback>,
    @InjectModel(ProgressEvent.name)
    private readonly progressEventModel: Model<ProgressEvent>,
    private readonly engagementLog: EngagementLogService,
    private readonly context: GenOnContextService,
    private readonly engine: GenOnEngineService,
  ) {}

  async history(program: GenOnProgram, enrollmentId: string) {
    const e = Types.ObjectId.isValid(enrollmentId)
      ? await this.enrollmentModel.findById(enrollmentId).lean().exec()
      : null;
    if (!e || e.program_id !== String(program._id)) {
      throw new NotFoundException('Inscripción no encontrada en el programa');
    }

    const [course, person, messages, events, feedback] = await Promise.all([
      this.context.loadCourse(e.event_id),
      this.engine.resolvePerson(e.organization_id, e.user_id),
      this.engagementLog.historyFor(e.user_id, e.organization_id),
      this.progressEventModel.collection
        .find(
          { user_id: e.user_id, event_id: e.event_id },
          { projection: { type: 1, activity_id: 1, from: 1, to: 1, at: 1 } },
        )
        .sort({ at: 1 })
        .toArray(),
      this.feedbackModel
        .find({ enrollment_id: String(e._id) })
        .sort({ created_at: 1 })
        .lean()
        .exec(),
    ]);
    const activityName = new Map(
      (course?.activities || []).map((a) => [a.id, a.name]),
    );
    const name = (id: string | null | undefined) =>
      (id && activityName.get(String(id))) || 'Actividad';

    const items: HistoryItem[] = [];
    for (const m of messages as any[]) {
      // Solo los mensajes de este curso (o sin curso, como el reporte semanal)
      if (m.event_id && m.event_id !== e.event_id) continue;
      items.push({
        type: 'message',
        at: m.at,
        kind: m.kind,
        step: m.step ?? null,
        segment: m.segment ?? null,
        template: m.template ?? null,
        status: m.status,
        text: m.text ?? null,
        progress: m.progress ?? null,
        completed_activities: m.completed_activities ?? null,
        delivered_at: m.delivered_at ?? null,
        read_at: m.read_at ?? null,
        clicked_at: m.clicked_at ?? null,
        replied_at: m.replied_at ?? null,
        reply_text: m.reply_text ?? null,
        opted_out_at: m.opted_out_at ?? null,
        error: m.error || m.meta_error || null,
      });
    }
    items.push(...this.collapseProgress(events as any[], program.timezone, name));
    for (const c of e.challenges || []) {
      items.push({
        type: 'challenge',
        at: c.at,
        kind: c.kind || 'advance',
        activity_name: name(c.activity_id),
        passed: c.passed,
        correct: c.correct,
        total: c.total,
      });
    }
    for (const f of feedback as any[]) {
      items.push({
        type: 'feedback',
        at: f.created_at,
        feedback_type: f.type,
        text: f.text,
      });
    }
    items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    return {
      enrollment_id: String(e._id),
      user_id: e.user_id,
      name: person.name,
      email: person.email,
      phone: maskPhone(person.phone),
      course: course?.eventName || '',
      total_activities: course?.activities.length || 0,
      segment: e.segment,
      segment_since: e.segment_since,
      progress: e.progress,
      completed_activities: e.completed_activities,
      holdout: e.holdout,
      slot: e.slot,
      paused: e.paused,
      exited: e.exited,
      exit_reason: e.exit_reason,
      abandon_reason: e.abandon_reason,
      streak: e.streak,
      next_step_key: e.next_step_key,
      next_step_at: e.next_step_at,
      progress_since: (events as any[])[0]?.at ?? null,
      items,
    };
  }

  /**
   * Borra el historial de Gen.ON de la persona en el programa: sus mensajes
   * (con lo que se liberan el tope y la deduplicación), sus comentarios y su
   * inscripción (secuencia, retos, racha, cola). Luego la vuelve a segmentar
   * para que empiece de cero sin esperar a la segmentación diaria. El avance
   * del curso (progress_events) es dato académico y no se toca.
   */
  async clear(program: GenOnProgram, enrollmentId: string, now: Date) {
    const e = Types.ObjectId.isValid(enrollmentId)
      ? await this.enrollmentModel.findById(enrollmentId).lean().exec()
      : null;
    if (!e || e.program_id !== String(program._id)) {
      throw new NotFoundException('Inscripción no encontrada en el programa');
    }
    const [messages, feedback] = await Promise.all([
      this.engagementLog.deleteProgramHistory(e.user_id, e.program_id, e.event_id),
      this.feedbackModel.deleteMany({ enrollment_id: String(e._id) }).exec(),
    ]);
    await this.enrollmentModel.deleteOne({ _id: e._id }).exec();
    // Las inscripciones de prueba no salen de la segmentación
    if (!e.test) {
      await this.engine.resegmentPeople(program, e.event_id, new Set([e.user_id]), now);
    }
    const fresh = e.test
      ? null
      : await this.enrollmentModel
          .findOne({ program_id: e.program_id, event_id: e.event_id, user_id: e.user_id, test: false })
          .select('_id segment next_step_key next_step_at')
          .lean()
          .exec();
    return {
      messages_deleted: messages,
      feedback_deleted: feedback.deletedCount,
      enrollment: fresh
        ? {
            _id: String(fresh._id),
            segment: fresh.segment,
            next_step_key: fresh.next_step_key,
            next_step_at: fresh.next_step_at,
          }
        : null,
    };
  }

  /**
   * El avance se registra en cada actualización (p. ej. al ver un video): se
   * resume en un registro por actividad y día, y uno por día para el curso.
   */
  private collapseProgress(
    events: { type: string; activity_id: string | null; from: number; to: number; at: Date }[],
    timeZone: string,
    name: (id: string | null) => string,
  ): HistoryItem[] {
    const groups = new Map<string, { type: string; activity_id: string | null; from: number; to: number; at: Date }>();
    const out: HistoryItem[] = [];
    for (const ev of events) {
      if (ev.type === 'course_completed') {
        out.push({ type: 'course_completed', at: ev.at });
        continue;
      }
      const key = `${ev.type}:${ev.activity_id || ''}:${localDate(new Date(ev.at), timeZone)}`;
      const g = groups.get(key);
      if (g) {
        g.to = Math.max(g.to, ev.to);
        g.at = ev.at;
      } else {
        groups.set(key, { ...ev });
      }
    }
    for (const g of groups.values()) {
      if (g.type === 'activity_progress') {
        out.push({
          type: 'activity_progress',
          at: g.at,
          activity_id: String(g.activity_id),
          activity_name: name(g.activity_id),
          from: g.from,
          to: g.to,
        });
      } else {
        out.push({ type: 'course_progress', at: g.at, from: g.from, to: g.to });
      }
    }
    return out;
  }
}
