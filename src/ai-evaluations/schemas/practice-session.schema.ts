import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, Schema as MongooseSchema } from 'mongoose';
import {
  ActivityQuestionType,
  QuestionOption,
  QuestionPair,
} from './activity-question.schema';

export type PracticeSessionStatus =
  | 'invited' // enviada la invitación, esperando "Empezar"
  | 'choosing' // eligiendo de cuál actividad reciente practicar
  | 'in_progress'
  | 'completed'
  | 'declined' // respondió "Ahora no"
  | 'cancelled' // escribió "salir" o la reemplazó otra sesión
  | 'expired';

export const PRACTICE_ACTIVE_STATUSES: PracticeSessionStatus[] = [
  'invited',
  'choosing',
  'in_progress',
];

/**
 * Actividad reciente entre las que el estudiante elige al empezar el
 * simulacro (las últimas que completó con preguntas sin ver).
 */
export interface PracticeActivityOption {
  activity_id: Types.ObjectId;
  activity_name: string;
  event_id: Types.ObjectId;
  event_name: string;
  completed_at: Date | null;
  available: number;
}

/** Respuesta del estudiante a una pregunta del simulacro. */
export interface PracticeResponse {
  raw: string;
  score: number; // 0-100
  correct: boolean;
  skipped: boolean;
  feedback: string;
  answered_at: Date;
}

/**
 * Copia de la pregunta al momento de enviar el simulacro (si el admin la
 * edita después, la sesión conserva lo que vio el estudiante) + cómo se
 * presentó y la respuesta.
 */
export interface PracticeQuestion {
  question_id: Types.ObjectId;
  activity_id: Types.ObjectId;
  activity_name: string;
  event_id: Types.ObjectId;
  event_name: string;
  type: ActivityQuestionType;
  question: string;
  answer: string;
  options: QuestionOption[];
  pairs: QuestionPair[];
  accepted_answers: string[];
  key_points: string[];
  explanation: string;
  topic: string;
  start_time: number | null;
  // ordering: orden en que se mostraron los elementos (índices de options);
  // matching: orden en que se mostró la columna derecha (índices de pairs)
  shuffle: number[];
  invalid_tries: number;
  response: PracticeResponse | null;
}

/**
 * Simulacro de evaluación por WhatsApp (práctica, no cuenta para notas).
 * Lo dispara un admin o el repaso automático, con preguntas que el
 * estudiante no ha visto de las actividades que ha desarrollado.
 */
@Schema({
  collection: 'practice_sessions',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
})
export class PracticeSession extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user_id: Types.ObjectId;
  @Prop() user_name: string;
  @Prop() email: string;
  // Vacío en las prácticas dentro de la plataforma (channel "web")
  @Prop({ default: '' }) phone: string;
  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true })
  organization_id: Types.ObjectId;
  // Admin que lo envió; null en los repasos automáticos
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  triggered_by: Types.ObjectId | null;
  // manual: lo envió un admin · auto: repaso automático (PracticeReviewCron)
  // · student: el estudiante la inició desde la actividad (channel "web")
  @Prop({ type: String, default: 'manual' }) trigger:
    | 'manual'
    | 'auto'
    | 'student';
  // whatsapp: simulacro conversacional · web: práctica dentro de la plataforma
  @Prop({ type: String, default: 'whatsapp' }) channel: 'whatsapp' | 'web';
  // Curso del que salen las preguntas
  @Prop({ type: Types.ObjectId, ref: 'Event', default: null })
  event_id: Types.ObjectId | null;
  // Repaso automático: cubre actividades completadas hasta esta fecha
  @Prop({ type: Date, default: null }) material_until: Date | null;

  @Prop({ type: String, default: 'invited' }) status: PracticeSessionStatus;
  // Cómo se envió la invitación: plantilla (fuera de la ventana de 24 h) o
  // mensaje interactivo (dentro de la ventana)
  @Prop({ type: String, default: null }) invite_channel:
    | 'template'
    | 'interactive'
    | null;

  // Simulacros por WhatsApp: el estudiante elige al empezar entre estas
  // actividades y ahí se sortean `num_questions` preguntas de la elegida
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  activity_options: PracticeActivityOption[];
  @Prop({ default: 0 }) num_questions: number;
  @Prop({ type: Types.ObjectId, default: null })
  chosen_activity_id: Types.ObjectId | null;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  questions: PracticeQuestion[];
  @Prop({ default: 0 }) current_question: number;

  // Resultados (al terminar)
  @Prop({ type: Number, default: null }) score: number | null; // promedio 0-100
  @Prop({ type: Number, default: null }) correct_count: number | null;
  @Prop({ type: Number, default: null }) answered_count: number | null;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  messages: { role: 'user' | 'assistant'; content: string; created_at: Date }[];

  @Prop() invited_at: Date;
  @Prop() started_at: Date;
  @Prop() finished_at: Date;
  created_at: Date;
  updated_at: Date;
}

export const PracticeSessionSchema =
  SchemaFactory.createForClass(PracticeSession);
PracticeSessionSchema.index({ phone: 1, status: 1, updated_at: -1 });
PracticeSessionSchema.index({ organization_id: 1, created_at: -1 });
PracticeSessionSchema.index({
  user_id: 1,
  event_id: 1,
  trigger: 1,
  invited_at: -1,
});
