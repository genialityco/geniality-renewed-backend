import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Quiz, QuizDocument } from './schemas/quiz.schema';
import { CreateQuizDto, UpdateQuizDto, SubmitQuizAttempDto } from './dto/quiz.dto';

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
   * Busca la nota de un usuario en el quiz.
   * @param quizId - ID del quiz
   * @param userId - ID del usuario
   * @returns La nota (0-100) si el usuario está en listUserAttempts, false si no existe
   */
  async getScoreByUserId(
    quizId: string,
    userId: string,
  ): Promise<number | false> {
    const quiz = await this.quizModel.findById(quizId).exec();

    if (!quiz) {
      throw new NotFoundException(`Quiz ${quizId} not found`);
    }

    const userAttempt = quiz.listUserAttempts.find(
      (attempt) => attempt.userId === userId,
    );

    if (!userAttempt) {
      return false;
    }

    return userAttempt.score;
  }

  // ── Submit quiz attempt ───────────────────────────────────────────────

  /**
   * Guarda (o actualiza) el intento del usuario con sus respuestas y puntuación.
   * @param quizId - ID del quiz
   * @param dto - Contiene userId, userAnswers y score
   * @returns El intento guardado
   */
  async submitAttempt(
    quizId: string,
    dto: SubmitQuizAttempDto,
  ): Promise<QuizDocument> {
    const quiz = await this.quizModel.findById(quizId).exec();

    if (!quiz) {
      throw new NotFoundException(`Quiz ${quizId} not found`);
    }

    const { userId, userAnswers, score } = dto;

    // Buscar si ya existe un intento de este usuario
    const existingAttemptIndex = quiz.listUserAttempts.findIndex(
      (attempt) => attempt.userId === userId,
    );

    if (existingAttemptIndex !== -1) {
      // Actualizar intento existente
      quiz.listUserAttempts[existingAttemptIndex] = {
        userId,
        attemptedAt: new Date(),
        score: score ?? 0,
        userAnswers,
      };
    } else {
      // Crear nuevo intento
      quiz.listUserAttempts.push({
        userId,
        attemptedAt: new Date(),
        score: score ?? 0,
        userAnswers,
      });
    }

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
}
