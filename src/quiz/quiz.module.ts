import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Quiz, QuizSchema } from './schemas/quiz.schema';
import { QuizService } from './quiz.service';
import { QuizController } from './quiz.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Quiz.name, schema: QuizSchema }]),
  ],
  controllers: [QuizController],
  providers: [QuizService],
  exports: [QuizService], // export in case other modules need it (e.g. attempts)
})
export class QuizModule {}
