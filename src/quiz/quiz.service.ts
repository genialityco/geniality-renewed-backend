// quiz.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Quiz } from './schemas/quiz.schema';

@Injectable()
export class QuizService {
  constructor(@InjectModel(Quiz.name) private quizModel: Model<Quiz>) {}

  /**
   * Crea o actualiza el quiz para una actividad dada
   */
  async createOrUpdateQuiz(activityId: string, quizJson: any): Promise<Quiz> {
    const existing = await this.quizModel.findOne({ activity_id: activityId });
    if (existing) {
      // Actualiza
      existing.quiz_json = quizJson;
      return existing.save();
    } else {
      // Crea
      const created = new this.quizModel({
        activity_id: activityId,
        quiz_json: quizJson,
      });
      return created.save();
    }
  }

  /**
   * Obtener el quiz de una actividad
   */
  async findByActivityId(activityId: string): Promise<Quiz> {
    const quiz = await this.quizModel.findOne({ activity_id: activityId });
    if (!quiz) {
      throw new NotFoundException('No hay quiz para esta actividad');
    }
    return quiz;
  }

  /**
   * Eliminar el quiz (opcional)
   */
  async removeQuizByActivity(activityId: string): Promise<Quiz> {
    const deleted = await this.quizModel.findOneAndDelete({
      activity_id: activityId,
    });
    if (!deleted) {
      throw new NotFoundException('No se encontró el quiz para esta actividad');
    }
    return deleted;
  }
}
