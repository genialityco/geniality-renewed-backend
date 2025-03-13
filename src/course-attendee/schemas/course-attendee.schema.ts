// course-attendee.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Registra la inscripción de un usuario a un curso.
 */
@Schema({ timestamps: true })
export class CourseAttendee extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user_id: Types.ObjectId;

  // Ajusta el ref según tu modelo de curso (a veces se llama "Event")
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  event_id: Types.ObjectId;

  // Ejemplo: un estado de la inscripción (activo, completado, etc.)
  @Prop({ default: 'ACTIVE' })
  status: string;

  @Prop({ default: 0 })
  progress: number;
}

export const CourseAttendeeSchema =
  SchemaFactory.createForClass(CourseAttendee);
