import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { QuestionAttempt } from './schemas/question-attempt.schema';
import {
  PRACTICE_ACTIVE_STATUSES,
  PracticeSession,
} from './schemas/practice-session.schema';
import { idVariants } from './course-content.service';

/**
 * Regla única de "pregunta ya usada" para que a un estudiante nunca se le
 * repita una pregunta, sea en el video, en un simulacro manual o en el
 * repaso automático. Una pregunta está usada si:
 *
 * - tiene un intento suyo (respondida o saltada, en cualquier canal), o
 * - está en un simulacro activo (invitado o en curso): queda reservada, o
 * - se le mostró en un simulacro ya terminado (hasta la pregunta en la que
 *   iba, aunque no la respondiera).
 *
 * Las preguntas de invitaciones que nunca empezó (declinadas, vencidas o
 * canceladas sin empezar) no cuentan: no llegó a verlas.
 */
@Injectable()
export class QuestionUsageService {
  constructor(
    @InjectModel(QuestionAttempt.name)
    private readonly attemptModel: Model<QuestionAttempt>,
    @InjectModel(PracticeSession.name)
    private readonly sessionModel: Model<PracticeSession>,
  ) {}

  async usedQuestionIds(userId: unknown): Promise<Set<string>> {
    const userIds = idVariants(userId);
    const [attempted, sessions] = await Promise.all([
      this.attemptModel
        .distinct('question_id', { user_id: { $in: userIds } })
        .exec(),
      this.sessionModel
        .find({
          user_id: { $in: userIds },
          $or: [
            { status: { $in: PRACTICE_ACTIVE_STATUSES } },
            { started_at: { $ne: null } },
          ],
        })
        .select('status current_question questions.question_id')
        .lean()
        .exec(),
    ]);

    const used = new Set(attempted.map(String));
    for (const s of sessions) {
      const shown = PRACTICE_ACTIVE_STATUSES.includes(s.status)
        ? s.questions
        : s.questions.slice(0, (s.current_question || 0) + 1);
      for (const q of shown) used.add(String(q.question_id));
    }
    return used;
  }
}
