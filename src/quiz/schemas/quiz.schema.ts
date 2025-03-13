// quiz.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Quiz extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Activity', required: true, unique: true })
  activity_id: Types.ObjectId;
  /**
   * Almacena el JSON completo generado por SurveyJS (o IA).
   */
  @Prop({ type: Object, required: true })
  quiz_json: Record<string, any>;
}

export const QuizSchema = SchemaFactory.createForClass(Quiz);
