import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  NotFoundException,
  Put,
  Query,
} from '@nestjs/common';
import { QuizAttemptService } from './quiz-attempt.service';
import { QuizAttempt } from './schemas/quiz-attempt.schema';

@Controller('quiz-attempts')
export class QuizAttemptController {
  constructor(private readonly service: QuizAttemptService) {}

  // Crea un nuevo intento
  @Post()
  async createAttempt(@Body() body: any): Promise<QuizAttempt> {
    // body = { quiz_id, user_id, attempt_number, answers_data, total_score, max_score }
    return this.service.createAttempt(body);
  }

  // Retorna la lista de intentos de un usuario en un quiz
  @Get('byUserAndQuiz')
  async getByUserAndQuiz(
    @Query('quiz_id') quizId: string,
    @Query('user_id') userId: string,
  ): Promise<QuizAttempt[]> {
    if (!quizId || !userId) {
      throw new NotFoundException('Faltan quiz_id y user_id');
    }
    return this.service.findAttemptsByUserAndQuiz(quizId, userId);
  }

  // Retorna un attempt en particular
  @Get(':id')
  async findOne(@Param('id') id: string): Promise<QuizAttempt> {
    return this.service.findById(id);
  }

  // (Opcional) Actualiza un attempt existente
  @Put(':id')
  async updateAttempt(
    @Param('id') id: string,
    @Body() body: any,
  ): Promise<QuizAttempt> {
    return this.service.updateAttempt(id, body);
  }
}
