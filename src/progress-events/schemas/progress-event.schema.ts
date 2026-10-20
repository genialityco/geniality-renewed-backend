import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProgressEventType =
  | 'activity_progress'
  | 'course_progress'
  | 'course_completed';

/**
 * Bitácora de solo inserción de los cambios de avance. CourseAttendee y
 * ActivityAttendee solo guardan el valor actual, así que sin este registro
 * no se puede saber cuándo avanzó o terminó un estudiante (necesario para
 * medir el efecto de las notificaciones contra la línea base).
 *
 * Los ids se guardan como string para no repetir el problema de tipos
 * mezclados (string/ObjectId) del resto de colecciones.
 */
@Schema({
  collection: 'progress_events',
  timestamps: { createdAt: 'created_at', updatedAt: false },
})
export class ProgressEvent extends Document {
  @Prop({ required: true }) user_id: string;
  @Prop({ required: true }) event_id: string;
  // Solo en 'activity_progress'
  @Prop({ type: String, default: null }) activity_id: string | null;
  @Prop({ required: true }) type: ProgressEventType;
  @Prop({ default: 0 }) from: number;
  @Prop({ default: 0 }) to: number;
  @Prop({ required: true, type: Date }) at: Date;
}

export const ProgressEventSchema = SchemaFactory.createForClass(ProgressEvent);

ProgressEventSchema.index({ event_id: 1, type: 1, at: -1 });
ProgressEventSchema.index({ user_id: 1, event_id: 1, at: -1 });
