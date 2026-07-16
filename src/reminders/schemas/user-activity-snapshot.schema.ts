import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export interface CourseTimeSnapshot {
  course_id: string;
  event_id: string;
  course_name?: string;
  time_spent_ms: number;
}

export interface ActivityTimeSnapshot {
  activity_id: string;
  event_id: string;
  activity_name?: string;
  time_spent_ms: number;
}

/**
 * Foto de los acumulados de useractivities al momento de enviar el reporte
 * semanal. El reporte de la semana siguiente = acumulado actual − último
 * snapshot; solo se guarda cuando el reporte se entregó (WhatsApp o email
 * de respaldo), así el tiempo no reportado se arrastra al siguiente envío.
 */
@Schema({ timestamps: true })
export class UserActivitySnapshot extends Document {
  @Prop({ required: true })
  user_id: string;

  @Prop({ required: true })
  organization_id: string;

  @Prop({ required: true, type: Date })
  taken_at: Date;

  @Prop({ default: 0 })
  total_courses_time_ms: number;

  @Prop({ default: 0 })
  total_activities_time_ms: number;

  @Prop({
    type: [
      {
        course_id: String,
        event_id: String,
        course_name: String,
        time_spent_ms: Number,
      },
    ],
    default: [],
  })
  courses: CourseTimeSnapshot[];

  @Prop({
    type: [
      {
        activity_id: String,
        event_id: String,
        activity_name: String,
        time_spent_ms: Number,
      },
    ],
    default: [],
  })
  activities: ActivityTimeSnapshot[];
}

export const UserActivitySnapshotSchema =
  SchemaFactory.createForClass(UserActivitySnapshot);

// El servicio consulta siempre el snapshot más reciente por usuario+org
UserActivitySnapshotSchema.index({
  user_id: 1,
  organization_id: 1,
  taken_at: -1,
});
