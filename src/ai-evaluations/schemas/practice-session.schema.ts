import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, Schema as MongooseSchema } from 'mongoose';
import {
  ActivityQuestionType,
  QuestionOption,
  QuestionPair,
} from './activity-question.schema';

export type PracticeSessionStatus =
  | 'invited' // enviada la invitación, esperando "Empezar"
  | 'in_progress'
  | 'completed'
  | 'declined' // respondió "Ahora no"
  | 'cancelled' // escribió "salir" o la reemplazó otra sesión
  | 'expired';

export const PRACTICE_ACTIVE_STATUSES: PracticeSessionStatus[] = [
  'invited',
  'in_progress',
];

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
 * Lo dispara un admin para un estudiante con las preguntas de las
 * actividades que ha desarrollado.
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
  @Prop({ required: true }) phone: string;
  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true })
  organization_id: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User' }) triggered_by: Types.ObjectId;

  @Prop({ type: String, default: 'invited' }) status: PracticeSessionStatus;
  // Cómo se envió la invitación: plantilla (fuera de la ventana de 24 h) o
  // mensaje interactivo (dentro de la ventana)
  @Prop({ type: String, default: null }) invite_channel:
    | 'template'
    | 'interactive'
    | null;

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
