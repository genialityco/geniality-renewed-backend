import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, Schema as MongooseSchema } from 'mongoose';

export type AiEvaluationStatus =
  | 'pending' // creada, esperando el primer mensaje por WhatsApp
  | 'selecting_module' // teléfono asociado, eligiendo módulo
  | 'in_progress' // respondiendo preguntas
  | 'completed'
  | 'cancelled'
  | 'expired';

export const ACTIVE_STATUSES: AiEvaluationStatus[] = [
  'selecting_module',
  'in_progress',
];

export interface AiEvaluationQuestion {
  question: string;
  key_points: string[];
  answer: string | null;
  score: number | null;
  feedback: string | null;
  clarifications: number;
  answered_at: Date | null;
}

export interface AiEvaluationMessage {
  role: 'user' | 'assistant';
  content: string;
  created_at: Date;
}

/**
 * Sesión de evaluación de conocimientos por WhatsApp: estado, preguntas
 * generadas con sus respuestas/calificaciones e historial de mensajes.
 */
@Schema({
  collection: 'ai_evaluation_sessions',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
})
export class AiEvaluationSession extends Document {
  @Prop({ required: true, unique: true }) code: string;
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true, index: true })
  event_id: Types.ObjectId;
  @Prop() event_name: string;
  @Prop({ type: Types.ObjectId, ref: 'Organization' })
  organization_id: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user_id: Types.ObjectId;
  @Prop() user_name: string;
  @Prop({ type: String, default: null }) phone: string | null;
  @Prop({ type: String, default: 'pending' }) status: AiEvaluationStatus;
  // Módulos ofrecidos al iniciar (snapshot)
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  modules: { id: string; name: string }[];
  // null = todo el curso
  @Prop({ type: String, default: null }) module_id: string | null;
  @Prop({ type: String, default: null }) module_name: string | null;
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  retry_module: { id: string | null; name: string | null } | null;
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  questions: AiEvaluationQuestion[];
  @Prop({ default: 0 }) current_question: number;
  @Prop({ type: Number, default: null }) passing_score: number | null;
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  messages: AiEvaluationMessage[];
  @Prop({ type: Types.ObjectId, default: null })
  result_id: Types.ObjectId | null;
  @Prop({ type: Number, default: null }) score: number | null;
  @Prop() code_expires_at: Date;
  @Prop() started_at: Date;
  @Prop() finished_at: Date;
  created_at: Date;
  updated_at: Date;
}

export const AiEvaluationSessionSchema =
  SchemaFactory.createForClass(AiEvaluationSession);
AiEvaluationSessionSchema.index({ phone: 1, status: 1, updated_at: -1 });
