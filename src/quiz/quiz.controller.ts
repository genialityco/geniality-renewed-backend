import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { QuizService } from './quiz.service';
import { CreateQuizDto, UpdateQuizDto, SubmitQuizAttempDto, UpdateQuizConfigDto } from './dto/quiz.dto';

@Controller('quiz')
export class QuizController {
  constructor(private readonly quizService: QuizService) {}

  /**
   * GET /quiz/event/:eventId
   * Returns the quiz for the given event, or null if it doesn't exist yet.
   * The frontend uses this to decide between create and edit mode.
   */
  @Get('event/:eventId')
  async findByEvent(@Param('eventId') eventId: string) {
    const quiz = await this.quizService.findByEventId(eventId);
    return quiz ?? null;
  }

  /**
   * GET /quiz/:quizId/score/:userId
   * Returns the score of a user, or false if the user hasn't taken the quiz.
   */
  @Get(':quizId/score/:userId')
  async getUserScore(
    @Param('quizId') quizId: string,
    @Param('userId') userId: string,
  ) {
    return this.quizService.getScoreByUserId(quizId, userId);
  }

  /**
   * GET /quiz/:quizId
   * Returns a quiz by its own id.
   */
  @Get(':quizId')
  async findOne(@Param('quizId') quizId: string) {
    return this.quizService.findById(quizId);
  }

  /**
   * POST /quiz
   * Creates a new quiz. Fails if the event already has one.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateQuizDto) {
    return this.quizService.create(dto);
  }

  /**
   * PUT /quiz/:quizId
   * Replaces all questions in an existing quiz.
   */
  @Put(':quizId')
  async update(@Param('quizId') quizId: string, @Body() dto: UpdateQuizDto) {
    return this.quizService.update(quizId, dto);
  }

  /**
   * DELETE /quiz/:quizId
   */
  @Delete(':quizId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('quizId') quizId: string) {
    return this.quizService.remove(quizId);
  }

  /**
   * POST /quiz/:quizId/submit
   * Almacena el intento del usuario (respuestas + puntuación).
   * Actualiza si el usuario ya tiene un intento previo.
   */
  @Post(':quizId/submit')
  @HttpCode(HttpStatus.CREATED)
  async submitAttempt(
    @Param('quizId') quizId: string,
    @Body() dto: SubmitQuizAttempDto,
  ) {
    return this.quizService.submitAttempt(quizId, dto);
  }

  /**
   * GET /quiz/:quizId/attempt/:userId
   * Obtiene el intento completo del usuario (respuestas + puntuación).
   */
  @Get(':quizId/attempt/:userId')
  async getUserAttempt(
    @Param('quizId') quizId: string,
    @Param('userId') userId: string,
  ) {
    return this.quizService.getUserAttempt(quizId, userId);
  }

  /**
   * PATCH /quiz/:quizId/config
   * Actualiza (merge) la configuración del quiz.
   * Solo sobreescribe los campos enviados; los demás conservan su valor.
   */
  @Patch(':quizId/config')
  async updateConfig(
    @Param('quizId') quizId: string,
    @Body() dto: UpdateQuizConfigDto,
  ) {
    return this.quizService.updateConfig(quizId, dto);
  }
}
