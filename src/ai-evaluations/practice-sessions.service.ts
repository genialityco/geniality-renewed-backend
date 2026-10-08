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
  PracticeActivityOption,
  PracticeSession,
} from './schemas/practice-session.schema';
import { idVariants } from './course-content.service';
import { randomQuestionCount } from './practice-format';
import { PracticeEngineService } from './practice-engine.service';
import { WhatsappInboundService } from './whatsapp-inbound.service';
import { QuestionUsageService } from './question-usage.service';

const MAX_NUM_QUESTIONS = 30;
// Al empezar, el estudiante elige entre sus últimas N actividades completadas
const MAX_ACTIVITY_OPTIONS = 3;
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

/** WhatsApp rechazó la invitación (la sesión ya quedó cancelada). */
class InviteError extends Error {}

interface Student {
  user: User;
  orgUser: OrganizationUser;
  name: string;
  email: string;
  phone: string | null;
}

type Material = Awaited<
  ReturnType<PracticeSessionsService['availableMaterial']>
>;

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
    private readonly usage: QuestionUsageService,
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
        channel: { $ne: 'web' },
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

  /** Crea el simulacro y envía la invitación por WhatsApp (admin). */
  async send(organizationId: string, body: PracticeSendBody, adminUid: string) {
    const student = await this.resolveStudent(organizationId, body.email);
    if (!student.orgUser.whatsapp_opt_in) {
      throw new BadRequestException(
        'El estudiante no ha autorizado recibir prácticas por WhatsApp (debe activarlo en su perfil).',
      );
    }
    if (!student.phone) {
      throw new BadRequestException(
        'El estudiante no tiene un teléfono registrado en la organización.',
      );
    }

    const num =
      body.num_questions === undefined || body.num_questions === null
        ? randomQuestionCount()
        : Math.round(Number(body.num_questions));
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
        `No hay preguntas nuevas en "${course.name}": el estudiante ya vio todas las preguntas activas de las actividades que ha desarrollado.`,
      );
    }

    const admin = await this.usersService.findByFirebaseUid(adminUid);
    try {
      return await this.createAndInvite({
        organizationId,
        student,
        course,
        material,
        num,
        trigger: 'manual',
        triggeredBy: admin._id as Types.ObjectId,
      });
    } catch (error) {
      if (error instanceof InviteError) {
        throw new BadGatewayException(error.message);
      }
      throw error;
    }
  }

  /**
   * Repaso automático (PracticeReviewCron): simulacro corto con preguntas no
   * vistas de las actividades que completó hasta `materialUntil`. Si no
   * corresponde enviarlo devuelve el motivo.
   */
  async sendAutoReview(params: {
    organizationId: string;
    userId: unknown;
    eventId: string;
    materialUntil: Date;
  }): Promise<{ sent: boolean; reason?: string }> {
    const { organizationId, userId, eventId, materialUntil } = params;
    const student = await this.resolveStudentById(organizationId, userId);
    if (!student) return { sent: false, reason: 'no_member' };
    if (!student.orgUser.whatsapp_opt_in)
      return { sent: false, reason: 'no_opt_in' };
    if (!student.phone) return { sent: false, reason: 'no_phone' };

    const active = await this.sessionModel
      .exists({
        $or: [{ user_id: student.user._id }, { phone: student.phone }],
        channel: { $ne: 'web' },
        status: { $in: PRACTICE_ACTIVE_STATUSES },
      })
      .exec();
    if (active) return { sent: false, reason: 'active_session' };

    const material = await this.availableMaterial(
      student.user._id,
      organizationId,
      DEFAULT_MIN_PROGRESS,
      eventId,
      { completedBefore: materialUntil },
    );
    const course = material.eventById.get(eventId);
    if (!course) return { sent: false, reason: 'no_course' };
    if (!material.questions.length)
      return { sent: false, reason: 'no_new_questions' };

    await this.createAndInvite({
      organizationId,
      student,
      course,
      material,
      num: randomQuestionCount(),
      trigger: 'auto',
      triggeredBy: null,
      materialUntil,
    });
    return { sent: true };
  }

  /**
   * Crea la sesión y envía la invitación: con botones dentro de la ventana
   * de 24 h, o con la plantilla aprobada fuera de ella. Las preguntas no se
   * eligen aquí: al empezar, el estudiante escoge entre sus últimas
   * actividades completadas con preguntas sin ver (activity_options) y el
   * motor sortea `num` de esa actividad. Si WhatsApp rechaza el envío,
   * cancela la sesión y lanza InviteError.
   */
  private async createAndInvite(params: {
    organizationId: string;
    student: Student;
    course: { _id: unknown; name: string };
    material: Material;
    num: number;
    trigger: 'manual' | 'auto';
    triggeredBy: Types.ObjectId | null;
    materialUntil?: Date;
  }) {
    const { organizationId, student, course, material, num, trigger } = params;
    const phone = student.phone as string;
    const activityOptions = material.activityOptions.slice(
      0,
      MAX_ACTIVITY_OPTIONS,
    );
    if (!activityOptions.length) {
      throw new BadRequestException(
        'No hay actividades con preguntas nuevas para este estudiante.',
      );
    }

    // Un solo simulacro activo por teléfono
    await this.practiceEngine.cancelActive(phone);

    const session = await this.sessionModel.create({
      user_id: student.user._id,
      user_name: student.name,
      email: student.email,
      phone,
      organization_id: new Types.ObjectId(organizationId),
      event_id: new Types.ObjectId(String(course._id)),
      triggered_by: params.triggeredBy,
      trigger,
      material_until: params.materialUntil || null,
      status: 'invited',
      activity_options: activityOptions,
      num_questions: num,
      questions: [],
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
    const windowOpen = await this.inbound.isWindowOpen(phone);
    try {
      if (windowOpen) {
        const sid = String(session._id);
        const intro =
          trigger === 'auto'
            ? `Hola ${firstName} 👋 ¡Hora de repasar! Preparamos un *simulacro de práctica* de ${num} preguntas sobre lo que viste en *${course.name}* (${orgName}).\n`
            : `Hola ${firstName} 👋 Preparamos un *simulacro de práctica* de ${num} preguntas del curso *${course.name}* en ${orgName}.\n`;
        await this.whatsapp.sendOutbound(phone, {
          body: intro + 'Es solo práctica: no afecta tus notas.',
          buttons: this.practiceEngine.inviteButtons(sid),
        });
      } else {
        await this.whatsapp.sendTemplate({
          to: phone,
          templateName: INVITE_TEMPLATE,
          languageCode: INVITE_TEMPLATE_LANG,
          parameters: [firstName, String(num), course.name, orgName],
        });
      }
    } catch (error) {
      const detail =
        (error as any)?.response?.data?.details || (error as Error).message;
      this.logger.error(
        `No se pudo enviar la invitación (${trigger}) a ${phone}: ${detail}`,
      );
      await this.sessionModel
        .updateOne(
          { _id: session._id },
          { $set: { status: 'cancelled', finished_at: new Date() } },
        )
        .exec();
      throw new InviteError(
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
      questions: num,
      courses: [course.name],
      activities: activityOptions.map((o) => o.activity_name),
      phone_masked: maskPhone(phone),
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
      trigger: s.trigger || 'manual',
      channel: s.channel || 'whatsapp',
      total_questions: s.questions.length || s.num_questions || 0,
      answered_count: s.answered_count,
      correct_count: s.correct_count,
      score: s.score,
      courses: [
        ...new Set(
          (s.questions.length ? s.questions : s.activity_options || []).map(
            (q) => q.event_name,
          ),
        ),
      ],
      activity_name: s.questions[0]?.activity_name || null,
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

  /** Estudiante de la organización por id de usuario (repaso automático). */
  private async resolveStudentById(
    organizationId: string,
    userId: unknown,
  ): Promise<Student | null> {
    if (!Types.ObjectId.isValid(String(userId))) return null;
    const [user, orgUser] = await Promise.all([
      this.userModel.findById(String(userId)).exec(),
      this.organizationUserModel
        .findOne({
          organization_id: { $in: idVariants(organizationId) },
          user_id: { $in: idVariants(userId) },
        })
        .exec(),
    ]);
    if (!user || !orgUser) return null;
    return {
      user,
      orgUser,
      name: resolveName(orgUser, user),
      email: orgUser.properties?.email || user.email || '',
      phone: resolvePhone(orgUser, user),
    };
  }

  /** Estudiante de la organización por email (de la membresía o del usuario). */
  private async resolveStudent(
    organizationId: string,
    email?: string,
  ): Promise<Student> {
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
   * (progreso >= minProgress) y sus preguntas activas que nunca ha visto (ver
   * QuestionUsageService). `completedBefore` limita a las actividades
   * completadas hasta esa fecha (repaso espaciado).
   */
  async availableMaterial(
    userId: unknown,
    organizationId: string,
    minProgress: number,
    eventId?: string,
    opts: { completedBefore?: Date } = {},
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
        ...(opts.completedBefore
          ? { updatedAt: { $lte: opts.completedBefore } }
          : {}),
      })
      .select('activity_id event_id progress updatedAt')
      .lean()
      .exec();
    const progressByActivity = new Map(
      attendees.map((a) => [String(a.activity_id), a.progress]),
    );
    const completedAt = new Map<string, Date | null>(
      attendees.map((a) => [
        String(a.activity_id),
        (a as any).updatedAt ? new Date((a as any).updatedAt) : null,
      ]),
    );
    const activityIds = [...progressByActivity.keys()];

    const [activities, allQuestions, used] = await Promise.all([
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
      this.usage.usedQuestionIds(userId),
    ]);
    const questions = allQuestions.filter((q) => !used.has(String(q._id)));
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

    // Actividades con preguntas sin ver, de la más reciente a la más antigua
    const activityOptions: PracticeActivityOption[] = activities
      .filter((a) => countByActivity.get(String(a._id)))
      .map((a) => ({
        activity_id: a._id as Types.ObjectId,
        activity_name: a.name || 'Actividad',
        event_id: a.event_id as unknown as Types.ObjectId,
        event_name: eventById.get(String(a.event_id))?.name || 'Curso',
        completed_at: completedAt.get(String(a._id)) || null,
        available: countByActivity.get(String(a._id)) || 0,
      }))
      .sort(
        (x, y) =>
          (y.completed_at?.getTime() || 0) - (x.completed_at?.getTime() || 0),
      );

    return { courses, questions, activityById, eventById, activityOptions };
  }
}
