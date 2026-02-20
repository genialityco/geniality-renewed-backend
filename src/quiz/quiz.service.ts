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


@Injectable()
export class QuizService {
  constructor(
    @InjectModel(Quiz.name) private readonly quizModel: Model<QuizDocument>,
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

    quiz.listUser = Array.isArray(quiz.listUser) ? quiz.listUser : [];

    const idx = quiz.listUser.findIndex((x: any) => x?.userId === dto.userId);

    if (idx >= 0) {
      // actualiza nota
      quiz.listUser[idx].result = dto.result;
    } else {
      // agrega nuevo
      quiz.listUser.push({ userId: dto.userId, result: dto.result });
    }

    await quiz.save();

    return {
      id: quiz.id,
      eventId: quiz.eventId,
      attempt: {
        userId: dto.userId,
        result: dto.result,
      },
    };
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
}
