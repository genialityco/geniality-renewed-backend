import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ProgressEvent } from './schemas/progress-event.schema';
import { CourseAttendee } from '../course-attendee/schemas/course-attendee.schema';

function idVariants(id: string | Types.ObjectId): any[] {
  const raw = String(id);
  const out: any[] = [raw];
  if (Types.ObjectId.isValid(raw) && String(new Types.ObjectId(raw)) === raw) {
    out.push(new Types.ObjectId(raw));
  }
  return out;
}

export type ActivityCompletedListener = (done: {
  userId: string;
  eventId: string;
  activityId: string;
}) => Promise<unknown> | unknown;

/**
 * Registra los cambios de avance y fija `CourseAttendee.completed_at` en el
 * momento en que un estudiante termina un curso. Nunca lanza: un fallo aquí
 * no debe impedir que se guarde el progreso del estudiante.
 */
@Injectable()
export class ProgressEventsService {
  private readonly logger = new Logger(ProgressEventsService.name);
  private readonly completedListeners: ActivityCompletedListener[] = [];

  constructor(
    @InjectModel(ProgressEvent.name)
    private readonly progressEventModel: Model<ProgressEvent>,
    @InjectModel(CourseAttendee.name)
    private readonly courseAttendeeModel: Model<CourseAttendee>,
  ) {}

  /** Solo registra avances (el progreso de actividad nunca baja: $max). */
  async recordActivityProgress(params: {
    userId: string;
    eventId: string;
    activityId: string;
    from: number;
    to: number;
  }): Promise<void> {
    if (params.to <= params.from) return;
    try {
      await this.progressEventModel.create({
        user_id: String(params.userId),
        event_id: String(params.eventId),
        activity_id: String(params.activityId),
        type: 'activity_progress',
        from: params.from,
        to: params.to,
        at: new Date(),
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo registrar avance de actividad: ${(error as Error).message}`,
      );
      return;
    }
    if (params.from < 100 && params.to >= 100) this.notifyCompleted(params);
  }

  /**
   * Avisa a quien lo pida (p. ej. la racha de Gen.ON) que una actividad se
   * terminó. Se registran al iniciar, sin que este módulo dependa de ellos.
   * No se espera ni falla el guardado del avance.
   */
  onActivityCompleted(listener: ActivityCompletedListener) {
    this.completedListeners.push(listener);
  }

  private notifyCompleted(params: { userId: string; eventId: string; activityId: string }) {
    const done = {
      userId: String(params.userId),
      eventId: String(params.eventId),
      activityId: String(params.activityId),
    };
    for (const listener of this.completedListeners) {
      Promise.resolve()
        .then(() => listener(done))
        .catch((error) =>
          this.logger.warn(
            `Aviso de actividad terminada falló: ${(error as Error).message}`,
          ),
        );
    }
  }

  /**
   * Registra un cambio del progreso del curso. Si cruza al 100% desde abajo,
   * fija `completed_at` (solo la primera vez) y registra 'course_completed'.
   *
   * Quien ya estaba en 100% antes de existir este registro no recibe
   * `completed_at`: su fecha real se desconoce y se estima aparte en los
   * snapshots de línea base, sin mezclarla con fechas medidas.
   */
  async recordCourseProgress(params: {
    userId: string;
    eventId: string;
    from: number;
    to: number;
  }): Promise<void> {
    const { userId, eventId, from, to } = params;
    if (to === from) return;
    try {
      const now = new Date();
      await this.progressEventModel.create({
        user_id: String(userId),
        event_id: String(eventId),
        activity_id: null,
        type: 'course_progress',
        from,
        to,
        at: now,
      });

      if (from >= 100 || to < 100) return;

      const res = await this.courseAttendeeModel.collection.updateOne(
        {
          user_id: { $in: idVariants(userId) },
          event_id: { $in: idVariants(eventId) },
          completed_at: null,
        },
        { $set: { completed_at: now } },
      );
      if (res.modifiedCount > 0) {
        await this.progressEventModel.create({
          user_id: String(userId),
          event_id: String(eventId),
          activity_id: null,
          type: 'course_completed',
          from,
          to,
          at: now,
        });
      }
    } catch (error) {
      this.logger.warn(
        `No se pudo registrar avance del curso: ${(error as Error).message}`,
      );
    }
  }
}
