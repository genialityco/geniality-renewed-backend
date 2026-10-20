import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CourseUserStatus =
  | 'completed'
  | 'active'
  | 'inactive'
  | 'never_active';

export type CompletedAtSource = 'tracked' | 'estimated' | null;

/**
 * Estado de un estudiante en un curso al momento de congelar una línea base.
 * Solo se guarda para las líneas base (no para los snapshots diarios): la
 * evolución individual posterior queda en progress_events.
 */
@Schema({
  collection: 'course_snapshot_users',
  timestamps: { createdAt: 'created_at', updatedAt: false },
})
export class CourseSnapshotUser extends Document {
  @Prop({ required: true }) batch_id: string;
  @Prop({ required: true }) snapshot_id: string;
  @Prop({ required: true }) organization_id: string;
  @Prop({ required: true }) event_id: string;
  @Prop({ required: true }) user_id: string;
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

export const CourseSnapshotUserSchema =
  SchemaFactory.createForClass(CourseSnapshotUser);

CourseSnapshotUserSchema.index({ batch_id: 1, event_id: 1 });
CourseSnapshotUserSchema.index({ user_id: 1, event_id: 1 });
