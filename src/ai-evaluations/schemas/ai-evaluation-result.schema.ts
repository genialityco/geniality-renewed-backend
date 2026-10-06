import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, Schema as MongooseSchema } from 'mongoose';

/** Resultado final de una evaluación de conocimientos por WhatsApp. */
@Schema({
  collection: 'ai_evaluation_results',
  timestamps: { createdAt: 'created_at', updatedAt: false },
})
export class AiEvaluationResult extends Document {
  @Prop({ type: Types.ObjectId, required: true }) session_id: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user_id: Types.ObjectId;
  @Prop() user_name: string;
  @Prop() phone: string;
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  event_id: Types.ObjectId;
  @Prop() event_name: string;
  @Prop({ type: Types.ObjectId, ref: 'Organization' })
  organization_id: Types.ObjectId;
  // null cuando la evaluación fue de todo el curso
  @Prop({ type: String, default: null }) module_id: string | null;
  @Prop() module_name: string;
  // 0-100
  @Prop() score: number;
  @Prop() passed: boolean;
  @Prop() passing_score: number;
  @Prop() total_questions: number;
  @Prop() correct_answers: number;
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  questions: {
    question: string;
    key_points: string[];
    answer: string;
    score: number;
    feedback: string;
  }[];
  @Prop() summary: string;
  @Prop({ type: [String], default: [] }) strengths: string[];
  @Prop({ type: [String], default: [] }) improvements: string[];
  @Prop() recommendation: string;
  @Prop() started_at: Date;
  created_at: Date;
}

export const AiEvaluationResultSchema =
  SchemaFactory.createForClass(AiEvaluationResult);
AiEvaluationResultSchema.index({ user_id: 1, event_id: 1, created_at: -1 });
AiEvaluationResultSchema.index({ event_id: 1, created_at: -1 });
