import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export interface CourseTime {
  course_id: string;
  event_id: string;
  course_name?: string;
  time_spent_ms: number;
  last_updated: Date;
}

export interface ActivityTime {
  activity_id: string;
  event_id: string;
  activity_name?: string;
  time_spent_ms: number;
  last_updated: Date;
}

@Schema({ timestamps: true })
export class UserActivity extends Document {
  @Prop({ required: true })
  user_id: string;

  @Prop({ required: true })
  firebase_uid: string;

  @Prop({ required: true })
  organization_id: string;

  @Prop({ required: true, type: Date })
  session_start: Date;

  @Prop({ type: Date, default: null })
  session_end: Date | null;

  @Prop({ default: 0 })
  session_duration_ms: number;

  @Prop({
    type: [
      {
        course_id: String,
        event_id: String,
        course_name: String,
        time_spent_ms: Number,
        last_updated: { type: Date, default: Date.now },
      },
    ],
    default: [],
  })
  courses: CourseTime[];

  @Prop({
    type: [
      {
        activity_id: String,
        event_id: String,
        activity_name: String,
        time_spent_ms: Number,
        last_updated: { type: Date, default: Date.now },
      },
    ],
    default: [],
  })
  activities: ActivityTime[];

  @Prop({ default: 0 })
  total_courses_time_ms: number;

  @Prop({ default: 0 })
  total_activities_time_ms: number;

  @Prop({ type: Date, default: Date.now })
  last_updated: Date;

  @Prop({ default: true })
  is_active: boolean;
}

export const UserActivitySchema = SchemaFactory.createForClass(UserActivity);

// Índices para búsquedas frecuentes
UserActivitySchema.index({ user_id: 1 });
UserActivitySchema.index({ firebase_uid: 1 });
UserActivitySchema.index({ organization_id: 1 });
UserActivitySchema.index({ user_id: 1, organization_id: 1 });

// Índice único para prevenir duplicados: solo un registro por usuario+organización
UserActivitySchema.index({
  user_id: 1,
  organization_id: 1,
}, {
  unique: true,
  sparse: true,
});
