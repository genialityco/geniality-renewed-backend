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

  @Prop({
    required: true,
    enum: ['PUBLIC', 'PRIVATE', 'EXCLUSIVE_FOR_MEMBERS'],
  })
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

  // ===== Compuerta de exámenes de módulo =====
  // Bloquea el examen de cada módulo hasta cierto avance de sus actividades.
  @Prop({ default: false }) module_exam_gating_enabled: boolean;
  // Porcentaje de actividades del módulo que deben completarse (0-100).
  @Prop({ default: 100, min: 0, max: 100 }) module_exam_min_progress: number;
  // Mensaje que ve el alumno cuando el examen del módulo está bloqueado.
  @Prop({ default: '' }) module_exam_locked_message: string;

  // ===== Reglas de desbloqueo del certificado =====
  // Por defecto no hay reglas: el certificado se rige por el comportamiento actual.
  @Prop({ default: false }) certificate_gating_enabled: boolean;
  // Nº mínimo de actividades completadas requeridas. null = sin requisito.
  @Prop({ type: Number, default: null })
  certificate_required_activities: number | null;
  // Nº mínimo de exámenes aprobados requeridos. null = sin requisito.
  @Prop({ type: Number, default: null })
  certificate_required_exams: number | null;
  // Mensaje que ve el alumno cuando el certificado está bloqueado.
  @Prop({ default: '' }) certificate_locked_message: string;

  // ===== Preguntas dentro del video =====
  // Práctica opcional: pausan el video y muestran una pregunta cerrada del
  // banco de la actividad. No afectan el progreso ni el gating.
  @Prop({ default: false }) in_video_questions_enabled: boolean;
  // Minutos mínimos entre dos preguntas del mismo video.
  @Prop({ default: 5, min: 1, max: 120 })
  in_video_questions_interval_minutes: number;
  // Máximo de preguntas por video (por estudiante).
  @Prop({ default: 3, min: 1, max: 20 }) in_video_questions_max: number;

  // ===== Repaso automático por WhatsApp =====
  // Simulacro de 3-4 preguntas no vistas, días después de completar
  // actividades. Solo a estudiantes con opt-in y teléfono.
  @Prop({ default: false }) whatsapp_review_enabled: boolean;
  // Días entre completar actividades y recibir el repaso (y entre repasos).
  @Prop({ default: 2, min: 1, max: 60 }) whatsapp_review_delay_days: number;
  // Zona horaria IANA en la que se evalúan las franjas de envío.
  @Prop({ default: 'America/Bogota' }) whatsapp_review_timezone: string;
  // Días de la semana permitidos (0 = domingo … 6 = sábado).
  @Prop({ type: [Number], default: [1, 2, 3, 4, 5, 6] })
  whatsapp_review_days: number[];
  // Franjas en las que se puede enviar ([{ start: 'HH:mm', end: 'HH:mm' }]).
  @Prop({
    type: [MongooseSchema.Types.Mixed],
    default: [{ start: '09:00', end: '19:00' }],
  })
  whatsapp_review_windows: { start: string; end: string }[];
  // Franjas de descanso dentro de las anteriores: no se envía.
  @Prop({
    type: [MongooseSchema.Types.Mixed],
    default: [{ start: '12:00', end: '14:00' }],
  })
  whatsapp_review_rest_windows: { start: string; end: string }[];

  @Prop({ type: Map, of: MongooseSchema.Types.Mixed, default: {} })
  styles?: Record<string, any>;
}

export const EventSchema = SchemaFactory.createForClass(Event);
