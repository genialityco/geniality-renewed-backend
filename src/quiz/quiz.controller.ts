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
  BadRequestException,
} from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { QuizService } from './quiz.service';
import { CreateQuizDto, UpdateQuizDto, UpdateQuizConfigDto } from './dto/quiz.dto';

@Controller('quiz')
export class QuizController {
  constructor(private readonly quizService: QuizService) {}

  /**
   * GET /quiz/event/:eventId
   * Returns the quiz for the given event, or null if it doesn't exist yet.
   * The frontend uses this to decide between create and edit mode.
   * NOTA: Este debe ir antes de /:quizId para evitar que "event" sea interpretado como un ID
   */
  @Get('event/:eventId')
  async findByEvent(@Param('eventId') eventId: string) {
    if (!isValidObjectId(eventId)) {
      throw new BadRequestException(`Invalid eventId format: ${eventId}`);
    }
    try {
      const quiz = await this.quizService.findByEventId(eventId);
      return quiz ?? null;
    } catch (error) {
      throw new BadRequestException(
        `Error finding quiz for event ${eventId}: ${error.message}`,
      );
    }
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
