import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Quiz, QuizDocument } from './schemas/quiz.schema';
import { CreateQuizDto, UpdateQuizDto, UpdateQuizConfigDto, SubmitQuizAttemptDto } from './dto/quiz.dto';

@Injectable()
export class QuizService {
  constructor(
    @InjectModel(Quiz.name) private readonly quizModel: Model<QuizDocument>,
  ) {}

  // ── Create ────────────────────────────────────────────────────────────

  async create(dto: CreateQuizDto): Promise<QuizDocument> {
    const eventObjectId = new Types.ObjectId(dto.eventId);

    // Enforce one quiz per event at the service layer too (schema has unique index)
    const existing = await this.quizModel.findOne({ eventId: eventObjectId });
    if (existing) {
      throw new ConflictException(
        `A quiz already exists for event ${dto.eventId}. Use PUT to update it.`,
      );
    }

    const quiz = new this.quizModel({
      eventId: eventObjectId,
      questions: dto.questions,
    });

    return quiz.save();
  }

  // ── Find by event ─────────────────────────────────────────────────────

  async findByEventId(eventId: string): Promise<QuizDocument | null> {
    return this.quizModel
      .findOne({ eventId: new Types.ObjectId(eventId) })
      .exec();
  }

  // ── Find by quiz id ───────────────────────────────────────────────────

  async findById(quizId: string): Promise<QuizDocument> {
    const quiz = await this.quizModel.findById(quizId).exec();
    if (!quiz) throw new NotFoundException(`Quiz ${quizId} not found`);
    return quiz;
  }

  // ── Update (full replace of questions) ───────────────────────────────

  async update(quizId: string, dto: UpdateQuizDto): Promise<QuizDocument> {
    const quiz = await this.quizModel
      .findByIdAndUpdate(
        quizId,
        { $set: { questions: dto.questions } },
        { new: true, runValidators: true },
      )
      .exec();

    if (!quiz) throw new NotFoundException(`Quiz ${quizId} not found`);
    return quiz;
  }

  // ── Delete ────────────────────────────────────────────────────────────

  async remove(quizId: string): Promise<void> {
    const result = await this.quizModel.findByIdAndDelete(quizId).exec();
    if (!result) throw new NotFoundException(`Quiz ${quizId} not found`);
  }

  // ── Get user score ────────────────────────────────────────────────────

  /**
   * Retorna la mejor nota (score más alto) de todos los intentos del usuario.
   * @param quizId - ID del quiz
   * @param userId - ID del usuario
   * @returns La mejor nota (0-100), o false si el usuario no tiene ningún intento
   */
  async getScoreByUserId(
    quizId: string,
    userId: string,
  ): Promise<number | false> {
    const quiz = await this.quizModel.findById(quizId).exec();

    if (!quiz) {
      throw new NotFoundException(`Quiz ${quizId} not found`);
    }

    const userAttempts = quiz.listUserAttempts.filter(
      (attempt) => attempt.userId === userId,
    );

    if (userAttempts.length === 0) {
      return false;
    }

    return Math.max(...userAttempts.map((a) => a.score));
  }

  // ── Submit quiz attempt ───────────────────────────────────────────────

  /**
   * Acumula un nuevo intento del usuario (nunca sobreescribe los anteriores).
   * @param quizId - ID del quiz
   * @param dto - Contiene userId, userAnswers y score
   * @returns El quiz con el nuevo intento añadido
   */
  async submitAttempt(
    quizId: string,
    dto: SubmitQuizAttemptDto,
  ): Promise<QuizDocument> {
    const quiz = await this.quizModel.findById(quizId).exec();

    if (!quiz) {
      throw new NotFoundException(`Quiz ${quizId} not found`);
    }

    const { userId, userAnswers, score } = dto;

    // Siempre añade un nuevo intento — nunca sobreescribe los anteriores
    quiz.listUserAttempts.push({
      userId,
      attemptedAt: new Date(),
      score: score ?? 0,
      userAnswers,
    });

    return quiz.save();
  }

  // ── Get user attempt ──────────────────────────────────────────────────

  /**
   * Obtiene el intento completo de un usuario (respuestas + score).
   * @param quizId - ID del quiz
   * @param userId - ID del usuario
   * @returns El intento del usuario o null si no existe
   */
  async getUserAttempt(quizId: string, userId: string): Promise<any | null> {
    const quiz = await this.quizModel.findById(quizId).exec();

    if (!quiz) {
      throw new NotFoundException(`Quiz ${quizId} not found`);
    }

    const userAttempt = quiz.listUserAttempts.find(
      (attempt) => attempt.userId === userId,
    );

    return userAttempt ?? null;
  }

  // ── Update config ────────────────────────────────────────────────

  /**
   * Actualiza (merge) la configuración del quiz.
   * Solo sobreescribe los campos enviados; los demás conservan su valor.
   * @param quizId - ID del quiz
   * @param dto   - Campos de configuración a actualizar
   * @returns El quiz actualizado
   */
  async updateConfig(
    quizId: string,
    dto: UpdateQuizConfigDto,
  ): Promise<QuizDocument> {
    // Construir el $set solo con los campos presentes en el DTO
    const configFields: Record<string, any> = {};
    for (const [key, value] of Object.entries(dto)) {
      configFields[`config.${key}`] = value;
    }

    const quiz = await this.quizModel
      .findByIdAndUpdate(
        quizId,
        { $set: configFields },
        { new: true, runValidators: true },
      )
      .exec();

    if (!quiz) throw new NotFoundException(`Quiz ${quizId} not found`);
    return quiz;
  }
}
