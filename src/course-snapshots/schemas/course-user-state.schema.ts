import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import {
  CompletedAtSource,
  CourseUserStatus,
} from './course-snapshot-user.schema';

/**
 * Estado actual de cada estudiante en cada curso, reemplazado por el snapshot
 * diario (un documento por curso y usuario, no uno por día). Responde "quién
 * está en riesgo hoy" sin recalcular; la evolución queda en progress_events y
 * el estado congelado en las líneas base.
 */
@Schema({
  collection: 'course_user_states',
  timestamps: { createdAt: false, updatedAt: 'updated_at' },
})
export class CourseUserState extends Document {
  @Prop({ required: true }) organization_id: string;
  @Prop({ required: true }) event_id: string;
  @Prop() event_name: string;
  @Prop({ required: true }) user_id: string;
  // Fecha local del snapshot diario que lo calculó
  @Prop({ required: true }) snapshot_date: string;
  @Prop({ type: Date, default: null }) enrolled_at: Date | null;
  @Prop({ default: 0 }) course_progress: number;
  @Prop({ default: 0 }) activity_progress: number;
  @Prop({ required: true }) status: CourseUserStatus;
  @Prop({ type: Date, default: null }) last_activity_at: Date | null;
  @Prop({ type: Number, default: null }) days_inactive: number | null;
  @Prop({ default: 0 }) time_spent_ms: number;
  @Prop({ type: Date, default: null }) completed_at: Date | null;
  @Prop({ type: String, default: null }) completed_at_source: CompletedAtSource;
  @Prop({ default: false }) has_phone: boolean;
  @Prop({ default: false }) whatsapp_opt_in: boolean;
}

export const CourseUserStateSchema =
  SchemaFactory.createForClass(CourseUserState);

CourseUserStateSchema.index({ event_id: 1, user_id: 1 }, { unique: true });
CourseUserStateSchema.index({ organization_id: 1, status: 1, days_inactive: -1 });
