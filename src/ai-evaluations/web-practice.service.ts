import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { UsersService } from 'src/users/users.service';
import { Event } from 'src/events/schemas/event.schema';
import { Activity } from 'src/activities/schemas/activity.schema';
import {
  ActivityQuestion,
  ActivityQuestionType,
} from './schemas/activity-question.schema';
import {
  PracticeQuestion,
  PracticeResponse,
  PracticeSession,
} from './schemas/practice-session.schema';
import { QuestionAttempt } from './schemas/question-attempt.schema';
import { QuestionUsageService } from './question-usage.service';
import { PracticeEngineService } from './practice-engine.service';
import {
  buildShuffle,
  gradeAnswer,
  randomQuestionCount,
  shuffleArray,
} from './practice-format';
import { idVariants } from './course-content.service';

// Tipos que se pueden responder en la plataforma (ordenar y relacionar
// quedan para WhatsApp)
const WEB_TYPES: ActivityQuestionType[] = [
  'single_choice',
  'multiple_choice',
  'true_false',
  'fill_blank',
  'open',
];
const CHOICE_TYPES: ActivityQuestionType[] = [
  'single_choice',
  'multiple_choice',
  'true_false',
];

export interface WebPracticeAnswerBody {
  index?: number;
  // Opción única / múltiple / verdadero-falso: índices elegidos
  selected?: number[];
  // Completar y abierta
  text?: string;
  skipped?: boolean;
}

type Session = PracticeSession;

/**
 * "Evaluar mis conocimientos" de una actividad, dentro de la plataforma:
 * práctica de 3-4 preguntas que el estudiante no ha visto (QuestionUsageService),
 * con retroalimentación por pregunta y resultado al final. Se guarda como
 * practice_session con channel "web" (sin teléfono) y cada respuesta en
 * question_attempts con source "web_practice", así no se repite en el video
 * ni en los simulacros por WhatsApp.
 */
@Injectable()
export class WebPracticeService {
  constructor(
    @InjectModel(ActivityQuestion.name)
    private readonly questionModel: Model<ActivityQuestion>,
    @InjectModel(PracticeSession.name)
    private readonly sessionModel: Model<PracticeSession>,
    @InjectModel(QuestionAttempt.name)
    private readonly attemptModel: Model<QuestionAttempt>,
    @InjectModel(Activity.name)
    private readonly activityModel: Model<Activity>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    private readonly usersService: UsersService,
    private readonly usage: QuestionUsageService,
    private readonly engine: PracticeEngineService,
  ) {}

  /** Preguntas nuevas disponibles y práctica en curso (para el botón). */
  async availability(uid: string, organizationId: string, activityId: string) {
    const { user } = await this.context(uid, organizationId, activityId);
    const [fresh, active] = await Promise.all([
      this.freshQuestions(user._id, activityId),
      this.activeSession(user._id, activityId),
    ]);
    return {
      available: fresh.length,
      active_session_id: active ? String(active._id) : null,
    };
  }

  /** Retoma la práctica en curso de la actividad o crea una nueva. */
  async start(uid: string, organizationId: string, activityId: string) {
    const { user, activity, event } = await this.context(
      uid,
      organizationId,
      activityId,
    );
    const active = await this.activeSession(user._id, activityId);
    if (active) return this.view(active);

    const fresh = await this.freshQuestions(user._id, activityId);
    if (!fresh.length) {
      throw new BadRequestException(
        'Ya respondiste todas las preguntas de esta actividad. ¡Buen trabajo!',
      );
    }
    const selected = shuffleArray(fresh).slice(0, randomQuestionCount());
    const questions: PracticeQuestion[] = selected.map((q) => {
      const base = {
        type: q.type || 'open',
        options: q.options || [],
        pairs: q.pairs || [],
      };
      return {
        question_id: q._id as Types.ObjectId,
        activity_id: q.activity_id,
        activity_name: activity.name || 'Actividad',
        event_id: q.event_id || activity.event_id,
        event_name: event.name || 'Curso',
        ...base,
        question: q.question,
        answer: q.answer,
        accepted_answers: q.accepted_answers || [],
        key_points: q.key_points || [],
        explanation: q.explanation || '',
        topic: q.topic || '',
        start_time: q.start_time ?? null,
        shuffle: buildShuffle(base),
        invalid_tries: 0,
        response: null,
      };
    });

    const now = new Date();
    const session = await this.sessionModel.create({
      user_id: user._id,
      user_name: user.names || '',
      email: user.email || '',
      phone: '',
      organization_id: new Types.ObjectId(organizationId),
      event_id: new Types.ObjectId(String(event._id)),
      trigger: 'student',
      channel: 'web',
      status: 'in_progress',
      questions,
      current_question: 0,
      invited_at: now,
      started_at: now,
    });
    return this.view(session);
  }

  async answer(
    uid: string,
    organizationId: string,
    activityId: string,
    sessionId: string,
    body: WebPracticeAnswerBody,
  ) {
    const { user } = await this.context(uid, organizationId, activityId);
    if (!Types.ObjectId.isValid(sessionId)) {
      throw new NotFoundException('Práctica no encontrada');
    }
    const session = await this.sessionModel
      .findOne({
        _id: new Types.ObjectId(sessionId),
        user_id: { $in: idVariants(user._id) },
        channel: 'web',
      })
      .exec();
    if (!session) throw new NotFoundException('Práctica no encontrada');
    if (session.status !== 'in_progress') {
      throw new BadRequestException('Esta práctica ya terminó');
    }

    const idx = session.current_question;
    if (Number(body?.index) !== idx) {
      // Doble clic o pestaña desactualizada: se devuelve el estado actual
      return { ...this.view(session), result: null };
    }
    const q = session.questions[idx];
    const sid = String(session._id);
    const skipped = Boolean(body?.skipped);

    let score = 0;
    let correct = false;
    let answer = '';
    let feedback = '';
    if (!skipped) {
      if (CHOICE_TYPES.includes(q.type)) {
        const graded = this.gradeChoice(q, body?.selected);
        ({ score, correct, answer } = graded);
      } else {
        const text = String(body?.text ?? '').trim();
        if (!text) throw new BadRequestException('Escribe tu respuesta');
        answer = text;
        const local =
          q.type === 'fill_blank'
            ? gradeAnswer(q, text, undefined, sid, idx)
            : null;
        if (local?.kind === 'invalid') {
          throw new BadRequestException(local.hint.replace(/\*/g, ''));
        }
        if (local?.kind === 'graded') {
          ({ score, correct } = local);
        } else {
          const ai = await this.engine.gradeWithAi(q, text);
          if (ai === 'error') {
            throw new ServiceUnavailableException(
              'No pudimos revisar tu respuesta. Intenta de nuevo en un momento.',
            );
          }
          if (ai.kind === 'doubt') {
            // Duda sobre la pregunta: se aclara y se deja responder de nuevo
            return { ...this.view(session), result: null, doubt: ai.feedback };
          }
          ({ score, correct, feedback } = ai);
        }
      }
    }

    const response: PracticeResponse = {
      raw: answer,
      score,
      correct,
      skipped,
      feedback,
      answered_at: new Date(),
    };
    q.response = response;
    session.current_question = idx + 1;
    const finished = idx + 1 >= session.questions.length;
    let summary: Record<string, any> = {};
    if (finished) {
      const answered = session.questions.filter((x) => x.response);
      const valid = answered.filter((x) => !x.response?.skipped);
      summary = {
        status: 'completed',
        finished_at: new Date(),
        answered_count: valid.length,
        correct_count: valid.filter((x) => x.response?.correct).length,
        score: answered.length
          ? Math.round(
              answered.reduce((sum, x) => sum + (x.response?.score || 0), 0) /
                answered.length,
            )
          : null,
      };
    }
    await this.sessionModel
      .updateOne(
        { _id: session._id },
        {
          $set: {
            [`questions.${idx}.response`]: response,
            current_question: idx + 1,
            ...summary,
          },
        },
      )
      .exec();
    if (finished) {
      session.status = 'completed';
      session.score = summary.score;
      session.correct_count = summary.correct_count;
      session.answered_count = summary.answered_count;
    }

    await this.attemptModel.create({
      user_id: session.user_id,
      organization_id: session.organization_id,
      question_id: q.question_id,
      activity_id: q.activity_id,
      event_id: q.event_id,
      session_id: session._id,
      source: 'web_practice',
      type: q.type,
      answer,
      score,
      correct,
      skipped,
    });

    return { ...this.view(session), result: this.resultOf(q) };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private gradeChoice(q: PracticeQuestion, raw?: number[]) {
    const options = q.options || [];
    const selected = [...new Set((raw || []).map(Number))].filter(
      (i) => Number.isInteger(i) && i >= 0 && i < options.length,
    );
    if (!selected.length) throw new BadRequestException('Elige una opción');
    if (q.type !== 'multiple_choice' && selected.length !== 1) {
      throw new BadRequestException('Elige solo una opción');
    }
    const totalCorrect = options.filter((o) => o.correct).length;
    const hits = selected.filter((i) => options[i].correct).length;
    const wrong = selected.length - hits;
    const correct = hits === totalCorrect && wrong === 0;
    const score = correct
      ? 100
      : q.type === 'multiple_choice' && totalCorrect
        ? Math.max(0, Math.round(((hits - wrong) / totalCorrect) * 100))
        : 0;
    return {
      score,
      correct,
      answer: selected.map((i) => options[i].text).join(', '),
      selected,
    };
  }

  /** Retroalimentación de una pregunta ya respondida (incluye la correcta). */
  private resultOf(q: PracticeQuestion) {
    const r = q.response as PracticeResponse;
    return {
      correct: r.correct,
      score: r.score,
      skipped: r.skipped,
      answer: r.raw,
      feedback: r.feedback,
      correct_options: CHOICE_TYPES.includes(q.type)
        ? q.options.map((o, i) => (o.correct ? i : -1)).filter((i) => i >= 0)
        : [],
      // Abiertas: la IA ya explica en feedback; no se muestra la respuesta modelo
      correct_answer: q.type === 'fill_blank' ? q.answer : '',
      explanation: q.explanation || '',
      start_time: q.start_time,
    };
  }

  /** Estado para el cliente: las pendientes sin respuesta correcta. */
  private view(session: Session) {
    return {
      session_id: String(session._id),
      status: session.status,
      current_question: session.current_question,
      total: session.questions.length,
      questions: session.questions.map((q, index) => ({
        index,
        type: q.type,
        question: q.question,
        options: CHOICE_TYPES.includes(q.type)
          ? q.options.map((o) => o.text)
          : [],
        result: q.response ? this.resultOf(q) : null,
      })),
      summary:
        session.status === 'completed'
          ? {
              score: session.score,
              correct_count: session.correct_count,
              answered_count: session.answered_count,
              total: session.questions.length,
            }
          : null,
    };
  }

  private async freshQuestions(userId: unknown, activityId: string) {
    const [questions, used] = await Promise.all([
      this.questionModel
        .find({
          activity_id: { $in: idVariants(activityId) },
          enabled: true,
          type: { $in: WEB_TYPES },
        })
        .lean()
        .exec(),
      this.usage.usedQuestionIds(userId),
    ]);
    return questions.filter((q) => !used.has(String(q._id)));
  }

  private activeSession(userId: unknown, activityId: string) {
    return this.sessionModel
      .findOne({
        user_id: { $in: idVariants(userId) },
        channel: 'web',
        status: 'in_progress',
        'questions.activity_id': { $in: idVariants(activityId) },
      })
      .sort({ created_at: -1 })
      .exec();
  }

  /** Usuario, actividad y curso, validando que la actividad sea de la organización. */
  private async context(
    uid: string,
    organizationId: string,
    activityId: string,
  ) {
    if (!Types.ObjectId.isValid(activityId)) {
      throw new NotFoundException('Actividad no encontrada');
    }
    const [user, activity] = await Promise.all([
      this.usersService.findByFirebaseUid(uid),
      this.activityModel
        .findById(activityId)
        .select('name event_id')
        .lean()
        .exec(),
    ]);
    if (!activity) throw new NotFoundException('Actividad no encontrada');
    const event = await this.eventModel
      .findById(activity.event_id)
      .select('name organizer_id')
      .lean()
      .exec();
    if (!event || String(event.organizer_id) !== String(organizationId)) {
      throw new ForbiddenException('La actividad no es de esta organización');
    }
    return { user, activity, event };
  }
}
