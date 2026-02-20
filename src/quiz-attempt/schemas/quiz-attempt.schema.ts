import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import * as mongoose from 'mongoose';

@Schema({ timestamps: true, collection: 'quiz_attempts' })
export class QuizAttempt extends Document {
  @Prop({ type: String, required: true, index: true })
  quizId: string;

  @Prop({ type: String, required: true, index: true })
  userId: string;

  @Prop({ default: 1, index: true })
  attemptNumber: number;

  // Respuestas del usuario - puede ser array u objeto
  @Prop({ type: mongoose.Schema.Types.Mixed })
  answersData: any; // Array o objeto con respuestas del usuario

  @Prop({ default: 0 })
  totalScore: number;

  @Prop({ default: 0 })
  maxScore: number;
}

export const QuizAttemptSchema = SchemaFactory.createForClass(QuizAttempt);

// Crear índice compuesto único
QuizAttemptSchema.index({ quizId: 1, userId: 1, attemptNumber: 1 }, { unique: false });


