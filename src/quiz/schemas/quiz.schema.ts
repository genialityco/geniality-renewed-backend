import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import * as mongoose from 'mongoose';
import {
  SingleChoiceQuestionSchema,
  MultipleChoiceQuestionSchema,
  MatchingQuestionSchema,
  OrderingQuestionSchema,
} from './question.schema';

export type QuizDocument = HydratedDocument<Quiz>;

@Schema({ _id: false }) // 👈 clave: no crear _id en cada item
export class QuizUserResult {
  @Prop({ type: String, required: true })
  userId: string;

  @Prop({ type: Number, required: true })
  result: number;
}

const QuizUserResultSchema = SchemaFactory.createForClass(QuizUserResult);
QuizUserResultSchema.set('_id', false); // Asegurar que no genere _id

@Schema({ _id: false })
export class BaseQuestion {
  @Prop({ type: String, required: true })
  id: string;

  @Prop({
    type: String,
    enum: ['single-choice', 'multiple-choice', 'matching', 'ordering'],
    required: true,
  })
  type: string;
}

@Schema({ timestamps: true, collection: 'quizzes' })
export class Quiz {
  @Prop({ type: String, default: () => uuidv4(), index: true, unique: true })
  id: string;

  @Prop({ type: String, required: true, unique: true, index: true })
  eventId: string;

  @Prop({
    type: [
      {
        type: mongoose.Schema.Types.Mixed,
        required: true,
      },
    ],
    required: true,
  })
  questions: (
    | SingleChoiceQuestionSchema
    | MultipleChoiceQuestionSchema
    | MatchingQuestionSchema
    | OrderingQuestionSchema
  )[];

  // 👇 aquí ya NO se genera _id por elemento
  @Prop({ type: [QuizUserResultSchema], default: [] })
  listUser: QuizUserResult[];
}

export const QuizSchema = SchemaFactory.createForClass(Quiz);
QuizSchema.index({ eventId: 1 }, { unique: true });
QuizSchema.index({ id: 1 }, { unique: true });
