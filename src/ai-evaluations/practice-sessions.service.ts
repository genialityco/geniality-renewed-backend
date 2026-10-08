import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { UsersService } from 'src/users/users.service';
import { User } from 'src/users/schemas/user.schema';
import { Event } from 'src/events/schemas/event.schema';
import { Activity } from 'src/activities/schemas/activity.schema';
import { ActivityAttendee } from 'src/activity-attendee/schemas/activity-attendee.schema';
import { OrganizationUser } from 'src/organization-users/schemas/organization-user.schema';
import { Organization } from 'src/organizations/schemas/organization.schema';
import { WhatsappGatewayClient } from 'src/reminders/whatsapp-gateway.client';
import { resolveName, resolvePhone } from 'src/reminders/contact.util';
import { ActivityQuestion } from './schemas/activity-question.schema';
import {
  PRACTICE_ACTIVE_STATUSES,
  PracticeQuestion,
  PracticeSession,
} from './schemas/practice-session.schema';
import { QuestionAttempt } from './schemas/question-attempt.schema';
import { idVariants } from './course-content.service';
import { buildShuffle } from './practice-format';
import { PracticeEngineService } from './practice-engine.service';
import { WhatsappInboundService } from './whatsapp-inbound.service';

// Si el admin no indica cuántas, el simulacro es corto: 3 o 4 preguntas al azar
const MIN_DEFAULT_QUESTIONS = 3;
const MAX_DEFAULT_QUESTIONS = 4;
const MAX_NUM_QUESTIONS = 30;
const DEFAULT_MIN_PROGRESS = Number(process.env.PRACTICE_MIN_PROGRESS) || 100;
// Plantilla aprobada en Meta para invitar fuera de la ventana de 24 h.
// Variables: {{1}} nombre, {{2}} número de preguntas, {{3}} curso,
// {{4}} organización. Botones quick reply: "Empezar" / "Ahora no".
const INVITE_TEMPLATE =
  process.env.PRACTICE_INVITE_TEMPLATE || 'simulacro_practica';
const INVITE_TEMPLATE_LANG = process.env.PRACTICE_INVITE_TEMPLATE_LANG || 'es';

export interface PracticeSendBody {
  email?: string;
  num_questions?: number;
  min_progress?: number;
  // Curso del simulacro: obligatorio al enviar; en la vista previa, si se
  // omite, se listan todos los cursos de la organización
  event_id?: string;
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskPhone(phone: string | null) {
  if (!phone) return null;
  return `${'•'.repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`;
}

/**
 * Simulacros de práctica por WhatsApp: el admin los envía a un estudiante
 * (por email) con preguntas de las actividades que ha desarrollado; el
 * estudiante gestiona su consentimiento (opt-in) desde el perfil.
 */
@Injectable()
export class PracticeSessionsService {
  private readonly logger = new Logger(PracticeSessionsService.name);

  constructor(
    @InjectModel(PracticeSession.name)
    private readonly sessionModel: Model<PracticeSession>,
    @InjectModel(QuestionAttempt.name)
    private readonly attemptModel: Model<QuestionAttempt>,
    @InjectModel(ActivityQuestion.name)
    private readonly questionModel: Model<ActivityQuestion>,
    @InjectModel(ActivityAttendee.name)
    private readonly attendeeModel: Model<ActivityAttendee>,
    @InjectModel(Activity.name)
    private readonly activityModel: Model<Activity>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(OrganizationUser.name)
    private readonly organizationUserModel: Model<OrganizationUser>,
    @InjectModel(Organization.name)
    private readonly organizationModel: Model<Organization>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly usersService: UsersService,
    private readonly practiceEngine: PracticeEngineService,
    private readonly inbound: WhatsappInboundService,
    private readonly whatsapp: WhatsappGatewayClient,
  ) {}

  // ─── Opt-in (estudiante) ───────────────────────────────────────────────

  async getOptIn(uid: string, organizationId: string) {
    const { user, orgUser } = await this.myMembership(uid, organizationId);
    const phone = resolvePhone(orgUser, user);
    return {
      opt_in: Boolean(orgUser.whatsapp_opt_in),
      opt_in_at: orgUser.whatsapp_opt_in_at || null,
      has_phone: Boolean(phone),
      phone_masked: maskPhone(phone),
    };
  }

  async setOptIn(uid: string, organizationId: string, optIn: boolean) {
    const { orgUser } = await this.myMembership(uid, organizationId);
    await this.organizationUserModel
      .updateOne(
        { _id: orgUser._id },
        {
          $set: {
            whatsapp_opt_in: optIn,
            whatsapp_opt_in_at: optIn ? new Date() : null,
          },
        },
      )
      .exec();
    return this.getOptIn(uid, organizationId);
  }

  private async myMembership(uid: string, organizationId: string) {
    const user = await this.usersService.findByFirebaseUid(uid);
    const orgUser = await this.organizationUserModel
      .findOne({
        user_id: { $in: idVariants(user._id) },
        organization_id: { $in: idVariants(organizationId) },
      })
      .exec();
    if (!orgUser)
      throw new NotFoundException('No perteneces a esta organización');
    return { user, orgUser };
  }

  // ─── Admin ─────────────────────────────────────────────────────────────

  /**
   * Organizaciones que administra el usuario (autor o rol administrativo),
   * misma regla que OrgAdminGuard: son las únicas donde puede enviar simulacros.
   */
  async adminOrganizations(uid: string) {
    const user = await this.usersService.findByFirebaseUid(uid);
    const userIds = idVariants(user._id);
    const [authored, memberships] = await Promise.all([
      this.organizationModel
        .find({ author: { $in: userIds } })
        .select('_id')
        .lean()
        .exec(),
      this.organizationUserModel
        .find({
          user_id: { $in: userIds },
          rol_id: { $in: [/^admin$/i, /^owner$/i, /^super_admin$/i] },
        })
        .select('organization_id')
        .lean()
        .exec(),
    ]);
    const ids = [
      ...new Set([
        ...authored.map((o) => String(o._id)),
        ...memberships.map((m) => String(m.organization_id)),
      ]),
    ].filter((id) => Types.ObjectId.isValid(id));

    const organizations = await this.organizationModel
      .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } })
      .select('name')
      .sort({ name: 1 })
      .lean()
      .exec();
    return organizations.map((o) => ({
      _id: String(o._id),
      name: (o as any).name || 'Organización',
    }));
  }

  /** Lo que se enviaría: estudiante, consentimiento, cursos y preguntas disponibles. */
  async preview(organizationId: string, body: PracticeSendBody) {
    const student = await this.resolveStudent(organizationId, body.email);
    const minProgress = this.minProgress(body.min_progress);
    const material = await this.availableMaterial(
      student.user._id,
      organizationId,
      minProgress,
      body.event_id,
    );
    const active = await this.sessionModel
      .findOne({
        user_id: student.user._id,
        organization_id: new Types.ObjectId(organizationId),
        status: { $in: PRACTICE_ACTIVE_STATUSES },
      })
      .select('status created_at')
      .lean()
      .exec();

    return {
      student: {
        user_id: String(student.user._id),
        name: student.name,
        email: student.email,
        has_phone: Boolean(student.phone),
        phone_masked: maskPhone(student.phone),
        opt_in: Boolean(student.orgUser.whatsapp_opt_in),
      },
      min_progress: minProgress,
      courses: material.courses,
      total_questions: material.questions.length,
      active_session: active
        ? {
            id: String(active._id),
            status: active.status,
            created_at: active.created_at,
          }
        : null,
    };
  }

  /** Crea el simulacro y envía la invitación por WhatsApp. */
  async send(organizationId: string, body: PracticeSendBody, adminUid: string) {
    const student = await this.resolveStudent(organizationId, body.email);
    // TEMPORAL: el opt-in de WhatsApp no bloquea el simulacro por ahora.
    // if (!student.orgUser.whatsapp_opt_in) {
    //   throw new BadRequestException(
    //     'El estudiante no ha autorizado recibir prácticas por WhatsApp (debe activarlo en su perfil).',
    //   );
    // }
    if (!student.phone) {
      throw new BadRequestException(
        'El estudiante no tiene un teléfono registrado en la organización.',
      );
    }

    const num = Math.round(
      Number(
        body.num_questions ??
          MIN_DEFAULT_QUESTIONS +
            Math.floor(
              Math.random() *
                (MAX_DEFAULT_QUESTIONS - MIN_DEFAULT_QUESTIONS + 1),
            ),
      ),
    );
    if (!Number.isFinite(num) || num < 1 || num > MAX_NUM_QUESTIONS) {
      throw new BadRequestException(
        `El número de preguntas debe estar entre 1 y ${MAX_NUM_QUESTIONS}`,
      );
    }
    if (!body.event_id || !Types.ObjectId.isValid(body.event_id)) {
      throw new BadRequestException('Selecciona el curso del simulacro');
    }
    const material = await this.availableMaterial(
      student.user._id,
      organizationId,
      this.minProgress(body.min_progress),
      body.event_id,
    );
    const course = material.eventById.get(body.event_id);
    if (!course) {
      throw new BadRequestException(
        'El curso no pertenece a esta organización',
      );
    }
    if (!material.questions.length) {
      throw new BadRequestException(
        `No hay preguntas disponibles en "${course.name}": el estudiante no ha desarrollado actividades de este curso con preguntas activas.`,
      );
    }

    const selected = await this.selectQuestions(
      student.user._id,
      material.questions,
      num,
    );
    const questions: PracticeQuestion[] = selected.map((q) => {
      const activity = material.activityById.get(String(q.activity_id));
      const base = {
        type: q.type || 'open',
        options: q.options || [],
        pairs: q.pairs || [],
      };
      return {
        question_id: q._id as Types.ObjectId,
        activity_id: q.activity_id,
        activity_name: activity?.name || 'Actividad',
        event_id: q.event_id,
        event_name: material.eventById.get(String(q.event_id))?.name || 'Curso',
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

    // Un solo simulacro activo por teléfono
    await this.practiceEngine.cancelActive(student.phone);

    const admin = await this.usersService.findByFirebaseUid(adminUid);
    const session = await this.sessionModel.create({
      user_id: student.user._id,
      user_name: student.name,
      email: student.email,
      phone: student.phone,
      organization_id: new Types.ObjectId(organizationId),
      triggered_by: admin._id,
      status: 'invited',
      questions,
      invited_at: new Date(),
    });

    const firstName = student.name.split(' ')[0];
    const organization = await this.organizationModel
      .findById(organizationId)
      .select('name')
      .lean()
      .exec();
    const orgName = (organization as any)?.name || 'la plataforma';

    // Dentro de la ventana de 24 h se puede invitar con botones (sin
    // plantilla); fuera de ella, solo con la plantilla aprobada.
    const windowOpen = await this.inbound.isWindowOpen(student.phone);
    try {
      if (windowOpen) {
        const sid = String(session._id);
        await this.whatsapp.sendOutbound(student.phone, {
          body:
            `Hola ${firstName} 👋 Preparamos un *simulacro de práctica* de ${questions.length} preguntas del curso *${course.name}* en ${orgName}.\n` +
            'Es solo práctica: no afecta tus notas.',
          buttons: this.practiceEngine.inviteButtons(sid),
        });
      } else {
        await this.whatsapp.sendTemplate({
          to: student.phone,
          templateName: INVITE_TEMPLATE,
          languageCode: INVITE_TEMPLATE_LANG,
          parameters: [
            firstName,
            String(questions.length),
            course.name,
            orgName,
          ],
        });
      }
    } catch (error) {
      const detail =
        (error as any)?.response?.data?.details || (error as Error).message;
      this.logger.error(
        `No se pudo enviar la invitación a ${student.phone}: ${detail}`,
      );
      await this.sessionModel
        .updateOne(
          { _id: session._id },
          { $set: { status: 'cancelled', finished_at: new Date() } },
        )
        .exec();
      throw new BadGatewayException(
        windowOpen
          ? `WhatsApp rechazó el mensaje: ${detail}`
          : `No se pudo enviar la plantilla "${INVITE_TEMPLATE}" (¿está aprobada en Meta?): ${detail}`,
      );
    }
    await this.sessionModel
      .updateOne(
        { _id: session._id },
        { $set: { invite_channel: windowOpen ? 'interactive' : 'template' } },
      )
      .exec();

    return {
      session_id: String(session._id),
      status: 'invited',
      invite_channel: windowOpen ? 'interactive' : 'template',
      questions: questions.length,
      courses: [...new Set(questions.map((q) => q.event_name))],
      phone_masked: maskPhone(student.phone),
    };
  }

  async listSessions(organizationId: string, email?: string) {
    const filter: Record<string, any> = {
      organization_id: new Types.ObjectId(organizationId),
    };
    if (email?.trim()) {
      filter.email = new RegExp(`^${escapeRegex(email.trim())}$`, 'i');
    }
    const sessions = await this.sessionModel
      .find(filter)
      .select('-messages -questions.key_points -questions.accepted_answers')
      .sort({ created_at: -1 })
      .limit(100)
      .lean()
      .exec();
    return sessions.map((s) => ({
      _id: s._id,
      user_name: s.user_name,
      email: s.email,
      status: s.status,
      invite_channel: s.invite_channel,
      total_questions: s.questions.length,
      answered_count: s.answered_count,
      correct_count: s.correct_count,
      score: s.score,
      courses: [...new Set(s.questions.map((q) => q.event_name))],
      invited_at: s.invited_at,
      started_at: s.started_at,
      finished_at: s.finished_at,
      created_at: s.created_at,
    }));
  }

  async getSession(organizationId: string, sessionId: string) {
    if (!Types.ObjectId.isValid(sessionId)) {
      throw new NotFoundException('Simulacro no encontrado');
    }
    const session = await this.sessionModel
      .findOne({
        _id: new Types.ObjectId(sessionId),
        organization_id: new Types.ObjectId(organizationId),
      })
      .lean()
      .exec();
    if (!session) throw new NotFoundException('Simulacro no encontrado');
    return session;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private minProgress(value?: number) {
    const n = Math.round(Number(value ?? DEFAULT_MIN_PROGRESS));
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      throw new BadRequestException('min_progress debe estar entre 1 y 100');
    }
    return n;
  }

  /** Estudiante de la organización por email (de la membresía o del usuario). */
  private async resolveStudent(organizationId: string, email?: string) {
    const clean = String(email || '').trim();
    if (!clean) throw new BadRequestException('El email es requerido');
    if (!Types.ObjectId.isValid(organizationId)) {
      throw new BadRequestException('Organización inválida');
    }
    const emailRegex = new RegExp(`^${escapeRegex(clean)}$`, 'i');
    const orgIds = idVariants(organizationId);

    let orgUser = await this.organizationUserModel
      .findOne({
        organization_id: { $in: orgIds },
        'properties.email': emailRegex,
      })
      .exec();
    let user: User | null = null;
    if (orgUser) {
      user = await this.userModel.findById(orgUser.user_id).exec();
    } else {
      user = await this.userModel.findOne({ email: emailRegex }).exec();
      if (user) {
        orgUser = await this.organizationUserModel
          .findOne({
            organization_id: { $in: orgIds },
            user_id: { $in: idVariants(user._id) },
          })
          .exec();
      }
    }
    if (!user || !orgUser) {
      throw new NotFoundException(
        'No se encontró un estudiante con ese email en la organización',
      );
    }
    return {
      user,
      orgUser,
      name: resolveName(orgUser, user),
      email: orgUser.properties?.email || user.email || clean,
      phone: resolvePhone(orgUser, user),
    };
  }

  /**
   * Cursos de la organización, actividades que el estudiante ha desarrollado
   * (progreso >= minProgress) y sus preguntas activas.
   */
  private async availableMaterial(
    userId: unknown,
    organizationId: string,
    minProgress: number,
    eventId?: string,
  ) {
    const eventFilter: Record<string, any> = {
      organizer_id: { $in: idVariants(organizationId) },
    };
    if (eventId) {
      if (!Types.ObjectId.isValid(eventId)) {
        throw new BadRequestException('Curso inválido');
      }
      eventFilter._id = new Types.ObjectId(eventId);
    }
    const events = await this.eventModel
      .find(eventFilter)
      .select('name')
      .lean()
      .exec();
    const eventById = new Map(events.map((e) => [String(e._id), e]));

    const attendees = await this.attendeeModel
      .find({
        user_id: { $in: idVariants(userId) },
        event_id: { $in: events.flatMap((e) => idVariants(e._id)) },
        progress: { $gte: minProgress },
      })
      .select('activity_id event_id progress')
      .lean()
      .exec();
    const progressByActivity = new Map(
      attendees.map((a) => [String(a.activity_id), a.progress]),
    );
    const activityIds = [...progressByActivity.keys()];

    const [activities, questions] = await Promise.all([
      this.activityModel
        .find({ _id: { $in: activityIds.map((id) => new Types.ObjectId(id)) } })
        .select('name event_id')
        .lean()
        .exec(),
      this.questionModel
        .find({
          activity_id: { $in: activityIds.flatMap(idVariants) },
          enabled: true,
        })
        .lean()
        .exec(),
    ]);
    const activityById = new Map(activities.map((a) => [String(a._id), a]));

    const countByActivity = new Map<string, number>();
    for (const q of questions) {
      const key = String(q.activity_id);
      countByActivity.set(key, (countByActivity.get(key) || 0) + 1);
    }

    const courses = events
      .map((e) => {
        const acts = activities
          .filter((a) => String(a.event_id) === String(e._id))
          .map((a) => ({
            activity_id: String(a._id),
            name: a.name,
            progress: progressByActivity.get(String(a._id)) || 0,
            questions: countByActivity.get(String(a._id)) || 0,
          }));
        return {
          event_id: String(e._id),
          event_name: e.name,
          activities: acts,
          questions: acts.reduce((sum, a) => sum + a.questions, 0),
        };
      })
      .filter((c) => c.activities.length);

    return { courses, questions, activityById, eventById };
  }

  /**
   * Elige `num` preguntas: primero las que falló la última vez, luego las no
   * vistas y al final las ya acertadas; repartidas entre actividades.
   */
  private async selectQuestions<
    T extends { _id: unknown; activity_id: Types.ObjectId },
  >(userId: unknown, questions: T[], num: number): Promise<T[]> {
    const history = await this.attemptModel
      .aggregate<{ _id: Types.ObjectId; last_correct: boolean }>([
        {
          $match: {
            user_id: { $in: idVariants(userId) },
            question_id: { $in: questions.map((q) => q._id) },
          },
        },
        { $sort: { created_at: -1 } },
        {
          $group: { _id: '$question_id', last_correct: { $first: '$correct' } },
        },
      ])
      .exec();
    const lastCorrect = new Map(
      history.map((h) => [String(h._id), h.last_correct]),
    );

    const ranked = questions
      .map((q) => {
        const seen = lastCorrect.get(String(q._id));
        const tier = seen === false ? 0 : seen === undefined ? 1 : 2;
        return { q, rank: tier + Math.random() * 0.9 };
      })
      .sort((a, b) => a.rank - b.rank)
      .map((r) => r.q);

    // Primera pasada con tope por actividad para repartir; luego se completa
    const activities = new Set(questions.map((q) => String(q.activity_id)))
      .size;
    const cap = Math.max(1, Math.ceil(num / activities));
    const perActivity = new Map<string, number>();
    const picked: T[] = [];
    for (const q of ranked) {
      if (picked.length >= num) break;
      const key = String(q.activity_id);
      if ((perActivity.get(key) || 0) >= cap) continue;
      perActivity.set(key, (perActivity.get(key) || 0) + 1);
      picked.push(q);
    }
    for (const q of ranked) {
      if (picked.length >= num) break;
      if (!picked.includes(q)) picked.push(q);
    }

    // Orden final aleatorio para mezclar cursos y tipos
    for (let i = picked.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [picked[i], picked[j]] = [picked[j], picked[i]];
    }
    return picked;
  }
}
