import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ActivityQuestionType } from './activity-question.schema';

/**
 * Un intento de un estudiante sobre una pregunta del banco
 * (`activity_questions`). Historial para analítica y para priorizar en los
 * siguientes simulacros las preguntas falladas o no vistas.
 */
@Schema({
  collection: 'question_attempts',
  timestamps: { createdAt: 'created_at', updatedAt: false },
})
export class QuestionAttempt extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user_id: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Organization' })
  organization_id: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) question_id: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Activity' }) activity_id: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Event' }) event_id: Types.ObjectId;
  // Sesión de origen (practice_sessions)
  @Prop({ type: Types.ObjectId }) session_id: Types.ObjectId;
  @Prop({ type: String, default: 'practice' }) source: 'practice';
  @Prop({ type: String }) type: ActivityQuestionType;
  @Prop({ default: '' }) answer: string;
  @Prop({ default: 0 }) score: number; // 0-100
  @Prop({ default: false }) correct: boolean;
  @Prop({ default: false }) skipped: boolean;
  created_at: Date;
}

export const QuestionAttemptSchema =
  SchemaFactory.createForClass(QuestionAttempt);
QuestionAttemptSchema.index({ user_id: 1, question_id: 1, created_at: -1 });
QuestionAttemptSchema.index({ question_id: 1 });
QuestionAttemptSchema.index({ organization_id: 1, created_at: -1 });
