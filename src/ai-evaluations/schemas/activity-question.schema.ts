import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, Schema as MongooseSchema } from 'mongoose';

export type ActivityQuestionDifficulty = 'basic' | 'intermediate' | 'advanced';
export type ActivityQuestionSource = 'ai' | 'manual';

export const QUESTION_TYPES = [
  'open', // abierta: answer = respuesta modelo + key_points
  'single_choice', // opción única: options con exactamente 1 correcta
  'multiple_choice', // selección múltiple: options con 2 o más correctas
  'true_false', // verdadero/falso: options [Verdadero, Falso]
  'fill_blank', // completar: "____" en la pregunta + answer/accepted_answers
  'ordering', // ordenar: options en el orden correcto
  'matching', // relacionar: pairs { left, right } correctos
] as const;
export type ActivityQuestionType = (typeof QUESTION_TYPES)[number];

export interface QuestionOption {
  text: string;
  correct: boolean;
}

export interface QuestionPair {
  left: string;
  right: string;
}

/**
 * Pregunta (abierta, opción única/múltiple, V/F, completar, ordenar o
 * relacionar) con su respuesta, asociada a una actividad. Se generan con IA a
 * partir de la información del curso y el transcript del video, y el admin
 * puede editarlas, desactivarlas o crear las suyas.
 */
@Schema({
  collection: 'activity_questions',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
})
export class ActivityQuestion extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Activity', required: true })
  activity_id: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  event_id: Types.ObjectId;
  @Prop({ type: String, default: null }) module_id: string | null;
  @Prop({ type: Types.ObjectId, ref: 'Organization' })
  organization_id: Types.ObjectId;

  @Prop({ type: String, default: 'open' }) type: ActivityQuestionType;
  @Prop({ required: true }) question: string;
  // Abierta: respuesta modelo. Otros tipos: la respuesta correcta en texto
  // (derivada de options/pairs), útil para listados y para calificar.
  @Prop({ default: '' }) answer: string;
  // single_choice / multiple_choice / true_false / ordering (orden correcto)
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  options: QuestionOption[];
  // matching
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  pairs: QuestionPair[];
  // fill_blank: otras respuestas válidas además de answer
  @Prop({ type: [String], default: [] }) accepted_answers: string[];
  // Por qué la respuesta es correcta (retroalimentación al estudiante)
  @Prop({ default: '' }) explanation: string;
  // Ideas que una respuesta correcta debe contener (para calificar)
  @Prop({ type: [String], default: [] }) key_points: string[];
  @Prop({ type: String, default: 'intermediate' })
  difficulty: ActivityQuestionDifficulty;
  @Prop({ default: '' }) topic: string;
  // Segundo del video donde se explica el tema (null si no se conoce)
  @Prop({ type: Number, default: null }) start_time: number | null;

  @Prop({ type: String, default: 'ai' }) source: ActivityQuestionSource;
  // true si el admin modificó una pregunta generada (no se borra al regenerar)
  @Prop({ default: false }) edited: boolean;
  @Prop({ default: true }) enabled: boolean;
  @Prop({ default: 0 }) order: number;
  @Prop({ type: Types.ObjectId, ref: 'User' }) updated_by: Types.ObjectId;
  created_at: Date;
  updated_at: Date;
}

export const ActivityQuestionSchema =
  SchemaFactory.createForClass(ActivityQuestion);
ActivityQuestionSchema.index({ activity_id: 1, order: 1 });
ActivityQuestionSchema.index({ event_id: 1 });
