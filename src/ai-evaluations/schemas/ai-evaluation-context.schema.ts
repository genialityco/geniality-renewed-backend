import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AiEvaluationDifficulty =
  | 'basic'
  | 'intermediate'
  | 'advanced'
  | 'mixed';

/**
 * Contexto curado por el admin que la IA usa para generar y calificar las
 * preguntas de la evaluación por WhatsApp. Uno por módulo, o uno para todo el
 * curso (module_id = null). Si un módulo no tiene contexto, se usa el
 * contenido en bruto (transcripciones, descripciones y documentos).
 */
@Schema({
  collection: 'ai_evaluation_contexts',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
})
export class AiEvaluationContext extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  event_id: Types.ObjectId;
  // null = contexto de todo el curso
  @Prop({ type: String, default: null }) module_id: string | null;
  @Prop({ type: Types.ObjectId, ref: 'Organization' })
  organization_id: Types.ObjectId;
  // false = el módulo no se ofrece en la evaluación
  @Prop({ default: true }) enabled: boolean;
  // Texto de referencia que usa la IA
  @Prop({ default: '' }) content: string;
  @Prop({ type: [String], default: [] }) learning_objectives: string[];
  // Indicaciones del docente (ej. "enfócate en casos clínicos")
  @Prop({ default: '' }) instructions: string;
  // Documentos (colección documents) cuyo texto se agrega al contexto
  @Prop({ type: [String], default: [] }) document_ids: string[];
  // Preguntas que siempre se incluyen
  @Prop({ type: [String], default: [] }) fixed_questions: string[];
  // null = valores por defecto del ambiente
  @Prop({ type: Number, default: null }) num_questions: number | null;
  @Prop({ type: Number, default: null }) passing_score: number | null;
  @Prop({ type: String, default: 'mixed' }) difficulty: AiEvaluationDifficulty;
  @Prop({ type: Types.ObjectId, ref: 'User' }) updated_by: Types.ObjectId;
  created_at: Date;
  updated_at: Date;
}

export const AiEvaluationContextSchema =
  SchemaFactory.createForClass(AiEvaluationContext);
AiEvaluationContextSchema.index(
  { event_id: 1, module_id: 1 },
  { unique: true },
);
