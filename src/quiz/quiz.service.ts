import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Quiz, QuizDocument } from './schemas/quiz.schema';
import { UpsertQuizDto } from './dto/upsert-quiz.dto';
import { SubmitQuizDto } from './dto/submit-quiz.dto';
import { SaveQuizResultDto } from './dto/save-quiz-result.dto';
import { QuizAttemptService } from '../quiz-attempt/quiz-attempt.service';


@Injectable()
export class QuizService {
  constructor(
    @InjectModel(Quiz.name) private readonly quizModel: Model<QuizDocument>,
    private readonly quizAttemptService: QuizAttemptService,
  ) {}

  async upsert(dto: UpsertQuizDto) {
    if (!dto.questions) {
      throw new BadRequestException('questions es requerido');
    }

    // Upsert por eventId
    const quiz = await this.quizModel.findOneAndUpdate(
      { eventId: dto.eventId },
      {
        $set: { questions: dto.questions },
        $setOnInsert: { listUser: [] },
      },
      { new: true, upsert: true },
    );

    return quiz;
  }

  async getByEventId(eventId: string) {
    const quiz = await this.quizModel.findOne({ eventId }).lean();
    if (!quiz)
      throw new NotFoundException(`Quiz no encontrado para eventId=${eventId}`);
    return quiz;
  }

  async deleteByEventId(eventId: string) {
    const res = await this.quizModel.deleteOne({ eventId });
    if (res.deletedCount === 0) {
      throw new NotFoundException(`Quiz no encontrado para eventId=${eventId}`);
    }
    return { deleted: true };
  }

  async submit(eventId: string, dto: SubmitQuizDto) {
    const quiz = await this.quizModel.findOne({ eventId });
    if (!quiz)
      throw new NotFoundException(`Quiz no encontrado para eventId=${eventId}`);

    // ✅ Solo devolver preguntas con respuestas correctas, sin guardar nada
    return {
      id: quiz.id,
      eventId: quiz.eventId,
      userId: dto.userId,
      questions: quiz.questions, // ✅ Incluye respuestas correctas (respuestacorrecta, respuestascorrectas, correctOrder)
    };
  }

  async saveResult(eventId: string, dto: SaveQuizResultDto) {
    const quiz = await this.quizModel.findOne({ eventId });
    if (!quiz)
      throw new NotFoundException(`Quiz no encontrado para eventId=${eventId}`);

    if (!dto.result && dto.result !== 0) {
      throw new BadRequestException('El campo result es requerido y debe ser un número');
    }

    try {
      const quizAttempt = await this.quizAttemptService.createAttempt({
        quizId: quiz.id,
        userId: dto.userId,
        attemptNumber: 1,
        answersData: dto.answers || [], // ✅ Respuestas del usuario
        totalScore: dto.result,
        maxScore: 5,
      });

      quiz.listUser = Array.isArray(quiz.listUser) ? quiz.listUser : [];

      const idx = quiz.listUser.findIndex((x: any) => x?.userId === dto.userId);

      if (idx >= 0) {
        quiz.listUser[idx].result = dto.result;
        quiz.listUser[idx].quizAttemptId = quizAttempt._id.toString();
      } else {
        quiz.listUser.push({
          userId: dto.userId,
          result: dto.result,
          quizAttemptId: quizAttempt._id.toString(),
        });
      }

      await quiz.save();

      return {
        id: quiz.id,
        eventId: quiz.eventId,
        attempt: {
          userId: dto.userId,
          result: dto.result,
          quizAttemptId: quizAttempt._id.toString(),
          answers_count: dto.answers?.length || 0,
        },
      };
    } catch (error) {
      console.error('❌ Error en saveResult:', error);
      throw error;
    }
  }

  async getForRun(eventId: string) {
    const quiz = await this.quizModel.findOne({ eventId }).lean();
    if (!quiz)
      throw new NotFoundException(`Quiz no encontrado para eventId=${eventId}`);

    const safeQuestions = this.removeCorrectAnswers(quiz.questions);

    return {
      id: quiz.id,
      eventId: quiz.eventId,
      questions: safeQuestions,
    };
  }
  private removeCorrectAnswers(obj: any): any {
    if (Array.isArray(obj)) return obj.map((x) => this.removeCorrectAnswers(x));

    if (obj && typeof obj === 'object') {
      const out: any = {};
      for (const [k, v] of Object.entries(obj)) {
        // Remover respuestas correctas según nuestro modelo
        if (
          k === 'respuestacorrecta' ||
          k === 'respuestascorrectas' ||
          k === 'correctAnswer' ||
          k === 'correctAnswers' ||
          k === 'correctOrder'
        )
          continue;
        out[k] = this.removeCorrectAnswers(v);
      }
      return out;
    }

    return obj;
  }

  // ✅ Comparar respuestas del usuario con respuestas correctas
  async evaluateAttempt(eventId: string, attemptId: string) {
    const quiz = await this.quizModel.findOne({ eventId });
    if (!quiz)
      throw new NotFoundException(`Quiz no encontrado para eventId=${eventId}`);

    const attempt = await this.quizAttemptService.findById(attemptId);
    if (!attempt)
      throw new NotFoundException(`Intento no encontrado con id=${attemptId}`);

    // ✅ Comparar cada respuesta
    const evaluation = (attempt.answersData || []).map((userAnswer: any, idx: number) => {
      const question = quiz.questions[idx];
      if (!question) {
        return {
          questionId: userAnswer.questionId,
          userAnswer,
          correctAnswer: null,
          isCorrect: false,
          type: 'unknown',
        };
      }

      let isCorrect = false;
      let correctAnswer = null;

      // Single Choice
      if (question.type === 'single-choice') {
        correctAnswer = question.respuestacorrecta;
        isCorrect = userAnswer.selectedOptionIndex === correctAnswer;
      }
      // Multiple Choice
      else if (question.type === 'multiple-choice') {
        correctAnswer = question.respuestascorrectas;
        isCorrect = Array.isArray(userAnswer.selectedOptionIndices) &&
          Array.isArray(correctAnswer) &&
          userAnswer.selectedOptionIndices.length === correctAnswer.length &&
          userAnswer.selectedOptionIndices.every((idx: number) => correctAnswer.includes(idx));
      }
      // Matching
      else if (question.type === 'matching') {
        correctAnswer = question.pairs;
        isCorrect = JSON.stringify(userAnswer.pairs) === JSON.stringify(correctAnswer);
      }
      // Ordering
      else if (question.type === 'ordering') {
        correctAnswer = question.correctOrder;
        isCorrect = JSON.stringify(userAnswer.orderedItemIds) === JSON.stringify(correctAnswer);
      }

      return {
        questionId: userAnswer.questionId,
        type: question.type,
        userAnswer,
        correctAnswer,
        isCorrect,
      };
    });

    // ✅ Calcular estadísticas
    const correctCount = evaluation.filter((e: any) => e.isCorrect).length;
    const totalCount = evaluation.length;
    const percentage = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;

    return {
      id: attempt._id.toString(),
      quiz: {
        id: quiz.id,
        eventId: quiz.eventId,
        questions: quiz.questions, // ✅ Incluir preguntas para el frontend
      },
      user_id: attempt.userId,
      result: attempt.totalScore,
      evaluation, // ✅ Array de evaluaciones por pregunta
      statistics: {
        correctCount,
        totalCount,
        percentage,
      },
    };
  }

  // ✅ Obtener detalles de un intento específico CON preguntas Y respuestas correctas
  async getAttempt(eventId: string, attemptId: string) {
    const quiz = await this.quizModel.findOne({ eventId });
    if (!quiz)
      throw new NotFoundException(`Quiz no encontrado para eventId=${eventId}`);

    const attempt = await this.quizAttemptService.findById(attemptId);
    if (!attempt)
      throw new NotFoundException(`Intento no encontrado con id=${attemptId}`);

    return {
      id: attempt._id.toString(),
      quiz: {
        id: quiz.id,
        eventId: quiz.eventId,
        questions: quiz.questions, // ✅ Preguntas completas CON respuestas correctas
      },
      user_id: attempt.userId,
      attempt_number: attempt.attemptNumber,
      answers: attempt.answersData, // ✅ Respuestas del usuario
      result: attempt.totalScore,
      max_score: attempt.maxScore,
    };
  }
}

