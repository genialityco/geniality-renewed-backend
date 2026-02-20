import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { QuizService } from './quiz.service';
import { UpsertQuizDto } from './dto/upsert-quiz.dto';
import { SubmitQuizDto } from './dto/submit-quiz.dto';
import { SaveQuizResultDto } from './dto/save-quiz-result.dto';

@Controller('quiz')
export class QuizController {
  constructor(private readonly quizService: QuizService) {}

  // Crear o editar (upsert por eventId)
  @Post()
  upsert(@Body() dto: UpsertQuizDto) {
    return this.quizService.upsert(dto);
  }

  @Get(':eventId')
  get(@Param('eventId') eventId: string) {
    return this.quizService.getByEventId(eventId);
  }

  @Delete(':eventId')
  remove(@Param('eventId') eventId: string) {
    return this.quizService.deleteByEventId(eventId);
  }

  // ✅ Submit: devuelve preguntas con respuestas correctas (sin guardar resultado)
  @Post(':eventId/submit')
  submit(@Param('eventId') eventId: string, @Body() dto: SubmitQuizDto) {
    return this.quizService.submit(eventId, dto);
  }

  // ✅ SaveResult: guarda el resultado después que el cliente lo calcula
  @Post(':eventId/save-result')
  saveResult(@Param('eventId') eventId: string, @Body() dto: SaveQuizResultDto) {
    return this.quizService.saveResult(eventId, dto);
  }

  @Get('event/:eventId')
  getForRun(@Param('eventId') eventId: string) {
    return this.quizService.getForRun(eventId);
  }
}
