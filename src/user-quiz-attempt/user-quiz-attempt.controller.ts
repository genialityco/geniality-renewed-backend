import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { UserQuizAttemptService } from './user-quiz-attempt.service';
import { SubmitAttemptDto, GradeAttemptDto, GradeOpenQuestionDto } from './dto/user-quiz-attempt.dto';

@Controller('user-quiz-attempt')
export class UserQuizAttemptController {
  constructor(private readonly service: UserQuizAttemptService) {}

  /**
   * POST /user-quiz-attempt/:quizId/submit
   * Almacena un nuevo intento del usuario.
   * - Valida el límite de intentos configurado en el quiz.
   * - Calcula el score automáticamente a partir de las respuestas.
   * NOTA: Las rutas más específicas (con más segmentos) van primero
   */
  @Post(':quizId/submit')
  @HttpCode(HttpStatus.CREATED)
  async submit(
    @Param('quizId') quizId: string,
    @Body() dto: SubmitAttemptDto,
  ) {
    return this.service.submit(quizId, dto);
  }

  /**
   * GET /user-quiz-attempt/:quizId/best-scores
   * Retorna todos los intentos de un quiz, mostrando solo el mejor score de cada usuario.
   * Incluye: userId, bestScore, attemptCount (número de intentos del usuario).
   */
  @Get(':quizId/best-scores')
  async getAllBestScores(
    @Param('quizId') quizId: string,
  ) {
    return this.service.getAllBestScores(quizId);
  }

  /**
   * GET /user-quiz-attempt/:quizId/user/:userId
   * Retorna todos los intentos de un usuario para un quiz,
   * ordenados del más reciente al más antiguo.
   */
  @Get(':quizId/user/:userId')
  async getByUser(
    @Param('quizId') quizId: string,
    @Param('userId') userId: string,
  ) {
    return this.service.getByUser(quizId, userId);
  }

  /**
   * GET /user-quiz-attempt/:quizId/score/:userId
   * Retorna el mejor score (máximo) de los intentos calificados del usuario,
   * o false si el usuario no tiene ningún intento.
   */
  @Get(':quizId/score/:userId')
  async getBestScore(
    @Param('quizId') quizId: string,
    @Param('userId') userId: string,
  ) {
    return this.service.getBestScore(quizId, userId);
  }

  /**
   * POST /user-quiz-attempt/:attemptId/grade-open-question
   * Califica una pregunta abierta específica.
   * Body: { questionId, score (1-10), gradedBy (opcional) }
   * Recalcula el score del intento y actualiza status según corresponda.
   */
  @Post(':attemptId/grade-open-question')
  @HttpCode(HttpStatus.OK)
  async gradeOpenQuestion(
    @Param('attemptId') attemptId: string,
    @Body() dto: GradeOpenQuestionDto,
  ) {
    return this.service.gradeOpenQuestion(attemptId, dto);
  }

  /**
   * PATCH /user-quiz-attempt/:attemptId/grade
   * Calificación manual: actualiza el score y marca el intento como calificado.
   */
  @Patch(':attemptId/grade')
  async grade(
    @Param('attemptId') attemptId: string,
    @Body() dto: GradeAttemptDto,
  ) {
    return this.service.grade(attemptId, dto);
  }

  /**
   * GET /user-quiz-attempt/:attemptId
   * Retorna un intento específico por su ID.
   * NOTA: Esta ruta va última para evitar conflictos con rutas más específicas
   */
  @Get(':attemptId')
  async getById(
    @Param('attemptId') attemptId: string,
  ) {
    return this.service.getById(attemptId);
  }
}
