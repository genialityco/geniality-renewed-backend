import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { QuizAttempt } from './schemas/quiz-attempt.schema';

@Injectable()
export class QuizAttemptService {
  constructor(
    @InjectModel(QuizAttempt.name)
    private quizAttemptModel: Model<QuizAttempt>,
  ) {}

  /**
   * Crea un nuevo intento o actualiza (depende de tu lógica).
   * Aquí suponemos que cada vez que se finaliza un test, guardamos un nuevo attempt.
   */
  async createAttempt(data: any): Promise<QuizAttempt> {
    // data = { quiz_id, user_id, attempt_number, answers_data, total_score, max_score }
    const attempt = new this.quizAttemptModel(data);
    return attempt.save();
  }

  /**
   * Encuentra todos los intentos de un usuario en un quiz
   */
  async findAttemptsByUserAndQuiz(
    quizId: string,
    userId: string,
  ): Promise<QuizAttempt[]> {
    return this.quizAttemptModel
      .find({ quiz_id: quizId, user_id: userId })
      .exec();
  }

  /**
   * Encuentra un attempt por su ID
   */
  async findById(id: string): Promise<QuizAttempt> {
    const attempt = await this.quizAttemptModel.findById(id).exec();
    if (!attempt) {
      throw new NotFoundException(`No se encontró el QuizAttempt con id ${id}`);
    }
    return attempt;
  }

  /**
   * (Opcional) Actualizar un attempt existente (si tu lógica lo requiere)
   */
  async updateAttempt(id: string, updateData: any): Promise<QuizAttempt> {
    const updated = await this.quizAttemptModel
      .findByIdAndUpdate(id, updateData, { new: true })
      .exec();
    if (!updated) {
      throw new NotFoundException(`No se encontró el QuizAttempt con id ${id}`);
    }
    return updated;
  }
}
