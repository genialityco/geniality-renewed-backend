// quiz.controller.ts
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  NotFoundException,
  Delete,
} from '@nestjs/common';
import { QuizService } from './quiz.service';
import { Quiz } from './schemas/quiz.schema';

@Controller('quiz')
export class QuizController {
  constructor(private readonly quizService: QuizService) {}

  /**
   * Crea o actualiza el quiz para una actividad
   */
  @Post()
  async createOrUpdate(@Body() body: any): Promise<Quiz> {
    const { activity_id, quiz_json } = body;
    if (!activity_id || !quiz_json) {
      throw new NotFoundException('Faltan datos: activity_id, quiz_json');
    }
    return this.quizService.createOrUpdateQuiz(activity_id, quiz_json);
  }

  /**
   * Obtiene el quiz de una actividad
   */
  @Get(':activityId')
  async findOne(@Param('activityId') activityId: string): Promise<Quiz> {
    return this.quizService.findByActivityId(activityId);
  }

  /**
   * Elimina el quiz asociado a una actividad (opcional)
   */
  @Delete(':activityId')
  async remove(@Param('activityId') activityId: string): Promise<Quiz> {
    return this.quizService.removeQuizByActivity(activityId);
  }
}
