import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Quiz, QuizDocument } from './schemas/quiz.schema';
import { CreateQuizDto, UpdateQuizDto, UpdateQuizConfigDto, SubmitQuizAttemptDto } from './dto/quiz.dto';

@Injectable()
export class QuizService implements OnModuleInit {
  private readonly logger = new Logger(QuizService.name);

  constructor(
    @InjectModel(Quiz.name) private readonly quizModel: Model<QuizDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Limpia índice legado de versiones anteriores para evitar:
    // E11000 duplicate key error ... index: activity_id_1 dup key: { activity_id: null }
    try {
      const indexes = await this.quizModel.collection.indexes();
      const legacyIndex = indexes.find((idx) => idx.name === 'activity_id_1');

      if (legacyIndex) {
        await this.quizModel.collection.dropIndex('activity_id_1');
        this.logger.warn(
          'Dropped legacy index "activity_id_1" from quizzes collection.',
        );
      }

      // Elimina el índice único legado por evento para permitir varios exámenes
      // por curso (uno general + uno por módulo).
      const uniqueEventIndex = indexes.find(
        (idx) => idx.name === 'eventId_1' && idx.unique,
      );
      if (uniqueEventIndex) {
        await this.quizModel.collection.dropIndex('eventId_1');
        this.logger.warn(
          'Dropped legacy unique index "eventId_1" from quizzes collection.',
        );
      }

      // Asegura que los índices definidos en el esquema queden sincronizados.
      await this.quizModel.syncIndexes();
    } catch (error) {
      this.logger.warn(
        `Could not reconcile quiz indexes on startup: ${error?.message ?? error}`,
      );
    }
  }

  // ── Create ────────────────────────────────────────────────────────────

  async create(dto: CreateQuizDto): Promise<QuizDocument> {
    const eventObjectId = new Types.ObjectId(dto.eventId);

    // Un evento admite varios exámenes: uno general (moduleId null) y uno por
    // módulo. Evitamos duplicar el examen general o el de un mismo módulo.
    const moduleObjectId = dto.moduleId
      ? new Types.ObjectId(dto.moduleId)
      : null;

    const existing = await this.quizModel.findOne({
      eventId: eventObjectId,
      moduleId: moduleObjectId,
    });
    if (existing) {
      throw new ConflictException(
        moduleObjectId
          ? `A quiz already exists for module ${dto.moduleId}. Use PUT to update it.`
          : `A general quiz already exists for event ${dto.eventId}. Use PUT to update it.`,
      );
    }

    const quiz = new this.quizModel({
      eventId: eventObjectId,
      moduleId: moduleObjectId,
      questions: dto.questions,
    });

    return quiz.save();
  }

  // ── Find by event ─────────────────────────────────────────────────────

  /** Devuelve el examen general del curso (moduleId null) para compatibilidad. */
  async findByEventId(eventId: string): Promise<QuizDocument | null> {
    return this.quizModel
      .findOne({ eventId: new Types.ObjectId(eventId), moduleId: null })
      .exec();
  }

  /** Devuelve todos los exámenes de un curso (general + por módulo). */
  async findAllByEventId(eventId: string): Promise<QuizDocument[]> {
    return this.quizModel
      .find({ eventId: new Types.ObjectId(eventId) })
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
    const update: Record<string, any> = { questions: dto.questions };
    // Permite reasignar el módulo del examen (o dejarlo como general con null).
    if (dto.moduleId !== undefined) {
      update.moduleId = dto.moduleId
        ? new Types.ObjectId(dto.moduleId)
        : null;
    }

    const quiz = await this.quizModel
      .findByIdAndUpdate(
        quizId,
        { $set: update },
        { new: true, runValidators: true },
      )
      .exec();

    if (!quiz) throw new NotFoundException(`Quiz ${quizId} not found`);
    return quiz;
  }

  // ── Enable / disable ──────────────────────────────────────────────────

  async setEnabled(quizId: string, enabled: boolean): Promise<QuizDocument> {
    const quiz = await this.quizModel
      .findByIdAndUpdate(
        quizId,
        { $set: { enabled } },
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
