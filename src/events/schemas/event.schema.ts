import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, Schema as MongooseSchema } from 'mongoose';

@Schema({
  timestamps: true,
})
export class Event extends Document {
  @Prop({ required: true }) name: string;
  @Prop() address?: string;
  @Prop() type_event?: 'onlineEvent' | 'inPerson';
  @Prop({ required: true }) datetime_from: Date;
  @Prop({ required: true }) datetime_to: Date;
  @Prop() picture?: string;
  @Prop() venue?: string;
  @Prop() location?: string;

  @Prop({ required: true, enum: ['PUBLIC', 'PRIVATE', 'EXCLUSIVE_FOR_MEMBERS'] })
  visibility: 'PUBLIC' | 'PRIVATE' | 'EXCLUSIVE_FOR_MEMBERS';

  @Prop() description?: string;
  @Prop({ default: false }) allow_register: boolean;

  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true })
  organizer_id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  author_id: Types.ObjectId;

  @Prop({ type: [String], default: [] }) position_ids?: string[];
  @Prop({ enum: ['zoom', 'google_meet', 'microsoft_teams'] })
  event_platform?: 'zoom' | 'google_meet' | 'microsoft_teams';
  @Prop({ default: 'es' }) language?: string;
  @Prop({ default: 0 }) progress: number;

  // ===== Reglas de avance del curso =====
  // Curso lineal: obliga a completar la actividad anterior antes de avanzar.
  @Prop({ default: false }) is_linear: boolean;
  // El examen requiere un porcentaje mínimo de avance del curso.
  @Prop({ default: false }) exam_gating_enabled: boolean;
  // Porcentaje mínimo de avance (0-100) para desbloquear el examen.
  @Prop({ default: 100, min: 0, max: 100 }) exam_min_progress: number;
  // Mensaje que ve el alumno cuando el examen está bloqueado.
  @Prop({ default: '' }) exam_locked_message: string;

  @Prop({ type: Map, of: MongooseSchema.Types.Mixed, default: {} })
  styles?: Record<string, any>;
}

export const EventSchema = SchemaFactory.createForClass(Event);
