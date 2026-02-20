import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { QuizService } from './quiz.service';
import { UpsertQuizDto } from './dto/upsert-quiz.dto';
import { SubmitQuizDto } from './dto/submit-quiz.dto';
import { SaveQuizResultDto } from './dto/save-quiz-result.dto';

@Controller('quiz')
export class QuizController {
  constructor(private readonly quizService: QuizService) {}

  // ✅ Rutas más específicas primero (con múltiples segmentos)
  @Get('event/:eventId')
  getForRun(@Param('eventId') eventId: string) {
    return this.quizService.getForRun(eventId);
  }

  // ✅ Evaluar intento (comparar respuestas) - MÁS ESPECÍFICA
  @Get(':eventId/attempt/:attemptId/evaluate')
  evaluateAttempt(@Param('eventId') eventId: string, @Param('attemptId') attemptId: string) {
    return this.quizService.evaluateAttempt(eventId, attemptId);
  }

  // ✅ Obtener intento - MENOS ESPECÍFICA
  @Get(':eventId/attempt/:attemptId')
  getAttempt(@Param('eventId') eventId: string, @Param('attemptId') attemptId: string) {
    return this.quizService.getAttempt(eventId, attemptId);
  }

  // ✅ POST antes que GET genérico
  @Post()
  upsert(@Body() dto: UpsertQuizDto) {
    return this.quizService.upsert(dto);
  }

  @Post(':eventId/submit')
  submit(@Param('eventId') eventId: string, @Body() dto: SubmitQuizDto) {
    return this.quizService.submit(eventId, dto);
  }

  @Post(':eventId/save-result')
  saveResult(@Param('eventId') eventId: string, @Body() dto: SaveQuizResultDto) {
    return this.quizService.saveResult(eventId, dto);
  }

  // ✅ Rutas genéricas al final
  @Get(':eventId')
  get(@Param('eventId') eventId: string) {
    return this.quizService.getByEventId(eventId);
  }

  @Delete(':eventId')
  remove(@Param('eventId') eventId: string) {
    return this.quizService.deleteByEventId(eventId);
  }
}
