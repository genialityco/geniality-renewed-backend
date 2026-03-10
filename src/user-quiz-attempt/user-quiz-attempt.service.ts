import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  UserQuizAttempt,
  UserQuizAttemptDocument,
} from './schemas/user-quiz-attempt.schema';
import { Quiz, QuizDocument } from '../quiz/schemas/quiz.schema';
import {
  SubmitAttemptDto,
  GradeAttemptDto,
  UserAnswerDto,
  GradeOpenQuestionDto,
} from './dto/user-quiz-attempt.dto';

@Injectable()
export class UserQuizAttemptService {
  constructor(
    @InjectModel(UserQuizAttempt.name)
    private readonly attemptModel: Model<UserQuizAttemptDocument>,
    @InjectModel(Quiz.name)
    private readonly quizModel: Model<QuizDocument>,
  ) {}

  // ── Calcular score automáticamente ───────────────────────────────────

  /**
   * Califica el examen en escala 0-100 usando puntos sobre el total de preguntas.
   *
   * - Cada pregunta no-abierta correcta aporta 1 punto.
   * - Cada pregunta abierta aporta entre 0.1 y 1.0 (score admin 1-10 => score/10).
   * - Si una pregunta abierta aún no está calificada, aporta 0.
   *
   * De esta forma, N preguntas equivalen a N puntos máximos y el porcentaje es:
   *   (puntos_obtenidos / N) * 100
   */
  private calculateScore(
    quiz: QuizDocument,
    userAnswers: UserAnswerDto[],
    manualScores: Array<{ questionId: string; score: number }> = [],
  ): { score: number; hasOpenQuestions: boolean } {
    const questions = quiz.questions;
    if (questions.length === 0) return { score: 0, hasOpenQuestions: false };

    let earnedPoints = 0;
    const totalQuestions = questions.length;
    const hasOpenQuestions = questions.some((q) => q.type === 'open');

    const manualScoreMap = new Map<string, number>(
      manualScores.map((ms) => [ms.questionId, ms.score]),
    );

    for (const question of questions) {
      const uAnswer = userAnswers.find((a) => a.questionId === question.id);

      // Pregunta abierta: solo suma si ya fue calificada manualmente.
      if (question.type === 'open') {
        const manual = manualScoreMap.get(question.id);
        if (typeof manual === 'number' && manual >= 1 && manual <= 10) {
          // 1 -> 0.1, 10 -> 1.0
          earnedPoints += manual / 10;
        }
        continue;
      }

      // Si no hay respuesta en pregunta auto-calificable, aporta 0 puntos.
      if (!uAnswer) continue;

      // Preguntas auto-calificables: correcta => +1 punto
      switch (question.type) {
        case 'single': {
          if (uAnswer.answer === question.correctAnswer) earnedPoints += 1;
          break;
        }

        case 'multiple': {
          const answered = [...((uAnswer.answer as string[]) ?? [])].sort();
          const expected = [...(question.correctAnswers ?? [])].sort();
          if (JSON.stringify(answered) === JSON.stringify(expected)) earnedPoints += 1;
          break;
        }

        case 'sorting': {
          const answered = (uAnswer.answer as string[]) ?? [];
          if (
            JSON.stringify(answered) ===
            JSON.stringify(question.correctOrder ?? [])
          )
            earnedPoints += 1;
          break;
        }

        case 'matching': {
          const answeredRows: Array<{
            columnAId: string;
            matches: Record<string, string>;
          }> = (uAnswer.answer as any[]) ?? [];
          const expectedRows = question.matchingAnswers ?? [];

          let allMatch = expectedRows.length > 0;

          for (const expRow of expectedRows) {
            const ansRow = answeredRows.find(
              (r) => r.columnAId === expRow.columnAId,
            );
            if (!ansRow) {
              allMatch = false;
              break;
            }
            for (const [col, val] of Object.entries(expRow.matches)) {
              if (ansRow.matches[col] !== val) {
                allMatch = false;
                break;
              }
            }
            if (!allMatch) break;
          }

          if (allMatch) earnedPoints += 1;
          break;
        }
      }
    }

    const score = Math.round((earnedPoints / totalQuestions) * 100);

    return { score: Math.min(100, score), hasOpenQuestions };
  }

  // ── Submit attempt ────────────────────────────────────────────────────

  /**
   * Almacena un nuevo intento del usuario.
   * Valida el límite de intentos configurado en el quiz.
   * Calcula el score automáticamente a partir de las respuestas.
   * 
   * Si el examen contiene preguntas abiertas sin calificar, se guarda con
   * status 'review' en lugar de 'graded'.
   */
  async submit(
    quizId: string,
    dto: SubmitAttemptDto,
  ): Promise<UserQuizAttemptDocument> {
    // quizId puede ser un UUID string, buscar por id o _id
    const quiz = await this.quizModel
      .findOne({
        $or: [{ _id: quizId }, { id: quizId }],
      })
      .exec();
    if (!quiz) throw new NotFoundException(`Quiz ${quizId} no encontrado`);

    const { userId, userAnswers } = dto;

    // ── Verificar límite de intentos ──────────────────────────────────
    const maxAttempts = quiz.config?.attempts ?? null; // null = ilimitados
    if (maxAttempts !== null) {
      const existingCount = await this.attemptModel
        .countDocuments({ quizId: quiz._id.toString(), userId })
        .exec();
      if (existingCount >= maxAttempts) {
        throw new ForbiddenException(
          `El usuario ${userId} ya alcanzó el límite de ${maxAttempts} intento(s) para este quiz.`,
        );
      }
    }

    // ── Calcular score y crear intento ────────────────────────────────
    const scoreResult = this.calculateScore(quiz, userAnswers);

    // Determinar el estado: si hay preguntas abiertas → 'review', sino 'graded'
    const status = scoreResult.hasOpenQuestions ? 'review' : 'graded';

    const attempt = new this.attemptModel({
      quizId: quiz._id.toString(), // Guardar el _id del quiz como string
      userId,
      attemptedAt: new Date(),
      status,
      score: scoreResult.score, // Score parcial (solo auto-calificables)
      userAnswers,
      manualScores: [], // Se llenará cuando el admin callifique
    });

    return attempt.save();
  }

  // ── Obtener intento por ID ──────────────────────────────────────────

  /**
   * Retorna un intento específico por su ID (_id de MongoDB).
   */
  async getById(attemptId: string): Promise<UserQuizAttemptDocument> {
    // Intentar buscar por _id como ObjectId
    try {
      const attempt = await this.attemptModel.findById(attemptId).exec();
      if (attempt) return attempt;
    } catch (error) {
      // Si no es un ObjectId válido, ignorar y continuar
    }

    // Si no se encuentra, devolver error
    throw new NotFoundException(`Intento ${attemptId} no encontrado`);
  }

  // ── Obtener intentos de un usuario ────────────────────────────────────

  /**
   * Retorna todos los intentos de un usuario para un quiz específico,
   * ordenados del más reciente al más antiguo.
   */
  async getByUser(
    quizId: string,
    userId: string,
  ): Promise<UserQuizAttemptDocument[]> {
    // Validar que el quiz exista (quizId puede ser UUID string)
    const quiz = await this.quizModel.findOne({
      $or: [{ _id: quizId }, { id: quizId }],
    });
    if (!quiz)
      throw new NotFoundException(`Quiz ${quizId} no encontrado`);

    return this.attemptModel
      .find({ quizId: quiz._id.toString(), userId })
      .sort({ attemptedAt: -1 })
      .exec();
  }

  // ── Obtener mejor score de un usuario ────────────────────────────────

  /**
   * Retorna el score más alto de todos los intentos del usuario.
   * @returns El mejor score (0–100), o false si no tiene intentos.
   */
  async getBestScore(
    quizId: string,
    userId: string,
  ): Promise<number | false> {
    // Buscar el quiz primero (quizId puede ser UUID string)
    const quiz = await this.quizModel.findOne({
      $or: [{ _id: quizId }, { id: quizId }],
    });
    if (!quiz)
      throw new NotFoundException(`Quiz ${quizId} no encontrado`);

    const attempts = await this.attemptModel
      .find({ quizId: quiz._id.toString(), userId, status: { $in: ['graded', 'review'] } })
      .select('score')
      .exec();

    if (attempts.length === 0) return false;

    return Math.max(...attempts.map((a) => a.score));
  }
  // ── Obtener todos los mejores scores por usuario ────────────────────────────┐

  /**
   * Retorna todos los intentos de un quiz, pero solo el mejor score de cada usuario.
   * Incluye: userId, mejorScore, y datos del usuario.
   */
  async getAllBestScores(
    quizId: string,
  ): Promise<
    Array<{ userId: string; bestScore: number | false; attemptCount: number }>
  > {
    // Buscar el quiz primero (quizId puede ser UUID string)
    const quiz = await this.quizModel.findOne({
      $or: [{ _id: quizId }, { id: quizId }],
    });
    if (!quiz)
      throw new NotFoundException(`Quiz ${quizId} no encontrado`);

    // Obtener todos los intentos del quiz (tanto 'graded' como 'review')
    const attempts = await this.attemptModel
      .find({ quizId: quiz._id.toString(), status: { $in: ['graded', 'review'] } })
      .select('userId score')
      .exec();

    // Agrupar por usuario y obtener el mejor score
    const userScoresMap = new Map<
      string,
      { bestScore: number; attemptCount: number }
    >();

    for (const attempt of attempts) {
      const userId = attempt.userId;
      const currentData = userScoresMap.get(userId);

      if (!currentData) {
        userScoresMap.set(userId, {
          bestScore: attempt.score,
          attemptCount: 1,
        });
      } else {
        if (attempt.score > currentData.bestScore) {
          currentData.bestScore = attempt.score;
        }
        currentData.attemptCount += 1;
      }
    }

    // Convertir a array ordenado por mejor score descendente
    return Array.from(userScoresMap.entries())
      .map(([userId, data]) => ({
        userId,
        bestScore: data.bestScore,
        attemptCount: data.attemptCount,
      }))
      .sort((a, b) => b.bestScore - a.bestScore);
  }

  // ──────────────────────────────────────────────────────────────────

  // ── Calificación de preguntas abiertas ─────────────────────────────────

  /**
   * Califica una pregunta abierta específica.
   * El admin envía una puntuación 1-10, que se convierte a 0.1-1 punto.
   * Recalcula el score del intento considerando todas las preguntas abiertas calificadas.
   * 
   * Si todas las preguntas abiertas ya fueron calificadas, cambia status a "graded".
   */
  async gradeOpenQuestion(
    attemptId: string,
    dto: GradeOpenQuestionDto,
  ): Promise<UserQuizAttemptDocument> {
    // ── Obtener el intento ────────────────────────────────────────────
    const attempt = await this.attemptModel.findById(attemptId).exec();
    if (!attempt)
      throw new NotFoundException(`Intento ${attemptId} no encontrado`);

    // ── Obtener el quiz asociado ──────────────────────────────────────
    const quiz = await this.quizModel.findById(attempt.quizId).exec();
    if (!quiz)
      throw new NotFoundException(`Quiz ${attempt.quizId} no encontrado`);

    // ── Validar que la pregunta exista y sea abierta ──────────────────
    const question = quiz.questions.find((q) => q.id === dto.questionId);
    if (!question)
      throw new NotFoundException(
        `Pregunta ${dto.questionId} no encontrada en este quiz`,
      );

    if (question.type !== 'open')
      throw new Error(
        `La pregunta ${dto.questionId} no es de tipo abierto (type: ${question.type})`,
      );

    // ── Validar que el score esté en rango 1-10 ─────────────────────
    if (dto.score < 1 || dto.score > 10)
      throw new Error(`Score debe estar entre 1 y 10, recibido: ${dto.score}`);

    // ── Agregar o actualizar la calificación manual ──────────────────
    const existingScoreIdx = attempt.manualScores.findIndex(
      (ms) => ms.questionId === dto.questionId,
    );

    if (existingScoreIdx >= 0) {
      // Actualizar
      attempt.manualScores[existingScoreIdx].score = dto.score;
      attempt.manualScores[existingScoreIdx].gradedAt = new Date();
      if (dto.gradedBy)
        attempt.manualScores[existingScoreIdx].gradedBy = dto.gradedBy;
    } else {
      // Crear nuevo
      attempt.manualScores.push({
        questionId: dto.questionId,
        score: dto.score,
        gradedAt: new Date(),
        gradedBy: dto.gradedBy || null,
      });
    }

    // ── Recalcular el score del intento ───────────────────────────────
    const scoreResult = this.calculateScore(
      quiz,
      attempt.userAnswers,
      attempt.manualScores,
    );

    // ── Determinar el nuevo status ────────────────────────────────────
    // Si hay preguntas abiertas, pasa a "graded" únicamente cuando
    // todas las preguntas abiertas tengan calificación manual.
    const openQuestions = quiz.questions.filter((q) => q.type === 'open');
    const gradedOpenQuestionIds = new Set(
      attempt.manualScores.map((ms) => ms.questionId),
    );
    const allOpenQuestionsGraded =
      openQuestions.length > 0 &&
      openQuestions.every((q) => gradedOpenQuestionIds.has(q.id));

    const newStatus: 'review' | 'graded' = scoreResult.hasOpenQuestions
      ? allOpenQuestionsGraded
        ? 'graded'
        : 'review'
      : 'graded';
    const newScore = scoreResult.score;

    // Actualizar el intento
    attempt.score = newScore;
    attempt.status = newStatus;

    return attempt.save();
  }

  // ── Calificación manual ───────────────────────────────────────────────

  /**
   * Actualiza el score y marca el intento como calificado.
   * Útil para sobreescribir la calificación automática.
   */
  async grade(
    attemptId: string,
    dto: GradeAttemptDto,
  ): Promise<UserQuizAttemptDocument> {
    const attempt = await this.attemptModel
      .findByIdAndUpdate(
        attemptId,
        { $set: { score: dto.score, status: 'graded' } },
        { new: true, runValidators: true },
      )
      .exec();

    if (!attempt)
      throw new NotFoundException(`Intento ${attemptId} no encontrado`);

    return attempt;
  }
}
