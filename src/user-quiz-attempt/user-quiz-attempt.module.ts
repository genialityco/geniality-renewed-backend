import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  UserQuizAttempt,
  UserQuizAttemptSchema,
} from './schemas/user-quiz-attempt.schema';
import { Quiz, QuizSchema } from '../quiz/schemas/quiz.schema';
import { UserQuizAttemptService } from './user-quiz-attempt.service';
import { UserQuizAttemptController } from './user-quiz-attempt.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserQuizAttempt.name, schema: UserQuizAttemptSchema },
      // Necesario para consultar config.attempts y questions al calificar
      { name: Quiz.name, schema: QuizSchema },
    ]),
  ],
  controllers: [UserQuizAttemptController],
  providers: [UserQuizAttemptService],
  exports: [UserQuizAttemptService],
})
export class UserQuizAttemptModule {}
