import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Quiz, QuizSchema } from './schemas/quiz.schema';
import { QuizService } from './quiz.service';
import { QuizController } from './quiz.controller';

@Module({
  imports: [
    MongooseModule.forFeatureAsync([
      {
        name: Quiz.name,
        useFactory: () => {
          // Desactiva la sincronización automática de índices.
          // QuizService.onModuleInit() se encargará de limpiar
          // el índice legacy "activity_id_1" y luego llamar syncIndexes().
          QuizSchema.set('autoIndex', false);
          return QuizSchema;
        },
      },
    ]),
  ],
  controllers: [QuizController],
  providers: [QuizService],
  exports: [QuizService],
})
export class QuizModule {}
