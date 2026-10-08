import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
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
import { QuestionAttempt } from './schemas/question-attempt.schema';
import { QuestionUsageService } from './question-usage.service';
import { idVariants } from './course-content.service';

// Solo tipos que se responden con un clic y se califican sin IA
const IN_VIDEO_TYPES: ActivityQuestionType[] = [
  'single_choice',
  'multiple_choice',
  'true_false',
];
// La pregunta aparece este tiempo después de que empieza a explicarse el
// tema (start_time), para preguntar sobre lo que ya se vio.
const TRIGGER_DELAY_SECONDS = 60;
const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_MAX_QUESTIONS = 3;

export interface InVideoAnswerBody {
  // Índices de las opciones elegidas (true_false: 0 = Verdadero, 1 = Falso)
  selected?: number[];
  skipped?: boolean;
}

/**
 * Preguntas dentro del video (práctica opcional, no afecta el progreso).
 * Elige preguntas cerradas del banco de la actividad que el estudiante no ha
 * visto en ningún canal, separadas por el intervalo del curso y hasta su
 * máximo por video. Cada respuesta (o salto) queda en `question_attempts`
 * con source "in_video", así no vuelve a aparecer en ningún lado.
 */
@Injectable()
export class InVideoQuestionsService {
  constructor(
    @InjectModel(ActivityQuestion.name)
    private readonly questionModel: Model<ActivityQuestion>,
    @InjectModel(QuestionAttempt.name)
    private readonly attemptModel: Model<QuestionAttempt>,
    @InjectModel(Activity.name)
    private readonly activityModel: Model<Activity>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    private readonly usersService: UsersService,
    private readonly usage: QuestionUsageService,
  ) {}

  async forActivity(uid: string, organizationId: string, activityId: string) {
    const { user, event } = await this.context(uid, organizationId, activityId);
    if (!event.in_video_questions_enabled) {
      return { enabled: false, questions: [] };
    }
    const intervalSeconds =
      (Number(event.in_video_questions_interval_minutes) ||
        DEFAULT_INTERVAL_MINUTES) * 60;
    const max = Number(event.in_video_questions_max) || DEFAULT_MAX_QUESTIONS;

    const [candidates, used, answeredHere] = await Promise.all([
      this.questionModel
        .find({
          activity_id: { $in: idVariants(activityId) },
          enabled: true,
          type: { $in: IN_VIDEO_TYPES },
          start_time: { $ne: null },
        })
        .sort({ start_time: 1, order: 1, _id: 1 })
        .lean()
        .exec(),
      this.usage.usedQuestionIds(user._id),
      this.attemptModel
        .find({
          user_id: { $in: idVariants(user._id) },
          activity_id: { $in: idVariants(activityId) },
          source: 'in_video',
        })
        .select('question_id')
        .lean()
        .exec(),
    ]);

    // Las que ya respondió en este video cuentan para el máximo y el intervalo
    const answeredIds = new Set(answeredHere.map((a) => String(a.question_id)));
    const slots = candidates
      .filter((q) => answeredIds.has(String(q._id)))
      .map((q) => triggerAt(q.start_time as number));
    let remaining = max - answeredIds.size;

    const picked: typeof candidates = [];
    for (const q of candidates) {
      if (remaining <= 0) break;
      if (used.has(String(q._id))) continue;
      const at = triggerAt(q.start_time as number);
      if (slots.some((s) => Math.abs(s - at) < intervalSeconds)) continue;
      slots.push(at);
      picked.push(q);
      remaining--;
    }

    return {
      enabled: true,
      questions: picked.map((q) => ({
        id: String(q._id),
        type: q.type,
        question: q.question,
        // Sin la marca de correcta: se califica en el servidor
        options: (q.options || []).map((o) => o.text),
        trigger_at: triggerAt(q.start_time as number),
        start_time: q.start_time,
      })),
    };
  }

  async answer(
    uid: string,
    organizationId: string,
    activityId: string,
    questionId: string,
    body: InVideoAnswerBody,
  ) {
    const { user, activity } = await this.context(
      uid,
      organizationId,
      activityId,
    );
    if (!Types.ObjectId.isValid(questionId)) {
      throw new NotFoundException('Pregunta no encontrada');
    }
    const q = await this.questionModel
      .findOne({
        _id: new Types.ObjectId(questionId),
        activity_id: { $in: idVariants(activityId) },
        enabled: true,
        type: { $in: IN_VIDEO_TYPES },
      })
      .lean()
      .exec();
    if (!q) throw new NotFoundException('Pregunta no encontrada');

    const already = await this.attemptModel
      .exists({ user_id: { $in: idVariants(user._id) }, question_id: q._id })
      .exec();
    if (already) throw new ConflictException('Ya respondiste esta pregunta');

    const options = q.options || [];
    const skipped = Boolean(body?.skipped);
    const selected = skipped
      ? []
      : [...new Set((body?.selected || []).map(Number))].filter(
          (i) => Number.isInteger(i) && i >= 0 && i < options.length,
        );
    if (!skipped) {
      if (!selected.length) throw new BadRequestException('Elige una opción');
      if (q.type !== 'multiple_choice' && selected.length !== 1) {
        throw new BadRequestException('Elige solo una opción');
      }
    }

    let score = 0;
    let correct = false;
    if (!skipped) {
      const totalCorrect = options.filter((o) => o.correct).length;
      const hits = selected.filter((i) => options[i].correct).length;
      const wrong = selected.length - hits;
      correct = hits === totalCorrect && wrong === 0;
      // Selección múltiple: crédito parcial (aciertos menos errores)
      score = correct
        ? 100
        : q.type === 'multiple_choice' && totalCorrect
          ? Math.max(0, Math.round(((hits - wrong) / totalCorrect) * 100))
          : 0;
    }

    await this.attemptModel.create({
      user_id: user._id,
      organization_id: new Types.ObjectId(organizationId),
      question_id: q._id,
      activity_id: q.activity_id,
      event_id: q.event_id || activity.event_id,
      session_id: null,
      source: 'in_video',
      type: q.type,
      answer: selected.map((i) => options[i].text).join(', '),
      score,
      correct,
      skipped,
    });

    return {
      correct,
      score,
      skipped,
      correct_options: options
        .map((o, i) => (o.correct ? i : -1))
        .filter((i) => i >= 0),
      explanation: q.explanation || '',
      start_time: q.start_time,
    };
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
      this.activityModel.findById(activityId).select('event_id').lean().exec(),
    ]);
    if (!activity) throw new NotFoundException('Actividad no encontrada');
    const event = await this.eventModel
      .findById(activity.event_id)
      .select(
        'organizer_id in_video_questions_enabled in_video_questions_interval_minutes in_video_questions_max',
      )
      .lean()
      .exec();
    if (!event || String(event.organizer_id) !== String(organizationId)) {
      throw new ForbiddenException('La actividad no es de esta organización');
    }
    return { user, activity, event };
  }
}

function triggerAt(startTime: number) {
  return Math.max(0, Math.round(startTime)) + TRIGGER_DELAY_SECONDS;
}
