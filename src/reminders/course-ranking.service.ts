import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserActivityService } from 'src/user-activity/user-activity.service';
import { UsersService } from 'src/users/users.service';
import { OrganizationsService } from 'src/organizations/organizations.service';
import { OrganizationUsersService } from 'src/organization-users/organization-users.service';
import { CourseAttendeeService } from 'src/course-attendee/course-attendee.service';
import {
  CourseTime,
  UserActivity,
} from 'src/user-activity/schemas/user-activity.schema';
import { WhatsappGatewayClient } from './whatsapp-gateway.client';
import { resolveEmail, resolveName, resolvePhone } from './contact.util';

// Con menos inscritos, "el promedio del grupo" equivale a exponer el avance
// puntual de uno o dos compañeros — se omite el curso hasta tener cohorte.
const MIN_COHORT_SIZE = 3;

interface CohortStats {
  avgProgress: number;
  maxProgress: number;
  progressByUser: Map<string, number>;
}

type RankingResult =
  | 'sent_leader'
  | 'sent_compare'
  | 'fallback_email'
  | 'skipped';

@Injectable()
export class CourseRankingService {
  private readonly logger = new Logger(CourseRankingService.name);

  private readonly baseUrl: string;

  constructor(
    private readonly userActivityService: UserActivityService,
    private readonly usersService: UsersService,
    private readonly organizationsService: OrganizationsService,
    private readonly organizationUsersService: OrganizationUsersService,
    private readonly courseAttendeeService: CourseAttendeeService,
    private readonly whatsappGateway: WhatsappGatewayClient,
    private readonly configService: ConfigService,
  ) {
    this.baseUrl =
      this.configService.get<string>('WHATSAPP_REMINDER_BASE_URL') ||
      'https://app.geniality.com.co';
  }

  /**
   * Compara a cada usuario con actividad esta semana contra el resto de
   * inscritos de su curso (por % de progreso en course-attendee, no tiempo
   * visto). Quien lidera el curso recibe un mensaje de refuerzo; el resto
   * recibe su avance frente al promedio del grupo, sin exponer el nombre ni
   * el progreso individual de ningún compañero.
   */
  async sendCourseRankingMessages(filter?: {
    userId?: string;
    organizationId?: string;
  }): Promise<{
    leaderSent: number;
    compareSent: number;
    fallbackEmail: number;
    skipped: number;
    failed: number;
  }> {
    if (!this.whatsappGateway.isConfigured) {
      this.logger.warn(
        'WHATSAPP_GATEWAY_URL no configurado, se omite el mensaje comparativo',
      );
      return {
        leaderSent: 0,
        compareSent: 0,
        fallbackEmail: 0,
        skipped: 0,
        failed: 0,
      };
    }

    let recentActivities = await this.userActivityService.findActiveSince(7);

    // Filtro opcional para pruebas/reenvíos dirigidos a un usuario u org
    if (filter?.userId) {
      recentActivities = recentActivities.filter(
        (a) => String(a.user_id) === filter.userId,
      );
    }
    if (filter?.organizationId) {
      recentActivities = recentActivities.filter(
        (a) => String(a.organization_id) === filter.organizationId,
      );
    }

    // Un usuario puede tocar varios cursos en la semana; para no mandarle
    // varios WhatsApp en la misma corrida se elige solo el más reciente.
    const candidates = recentActivities
      .map((activity) => ({
        activity,
        course: this.pickFeaturedCourse(activity),
      }))
      .filter(
        (c): c is { activity: UserActivity; course: CourseTime } => !!c.course,
      );

    this.logger.log(
      `Encontrados ${candidates.length} usuarios con curso activo esta semana`,
    );

    if (candidates.length > 0) {
      await this.whatsappGateway.registerAccount();
    }

    // Un mismo curso puede repetirse entre varios usuarios de la corrida;
    // se calcula el cohorte una sola vez por curso.
    const cohortCache = new Map<string, CohortStats | null>();
    let leaderSent = 0;
    let compareSent = 0;
    let fallbackEmail = 0;
    let skipped = 0;
    let failed = 0;

    for (const { activity, course } of candidates) {
      try {
        let cohort = cohortCache.get(course.event_id);
        if (cohort === undefined) {
          cohort = await this.computeCohortStats(course.event_id);
          cohortCache.set(course.event_id, cohort);
        }
        if (!cohort) {
          skipped++;
          continue;
        }

        const result = await this.sendRankingFor(activity, course, cohort);
        if (result === 'sent_leader') leaderSent++;
        else if (result === 'sent_compare') compareSent++;
        else if (result === 'fallback_email') fallbackEmail++;
        else skipped++;
      } catch (error) {
        failed++;
        this.logger.error(
          `Error enviando comparación para user_id=${activity.user_id}: ${
            (error as any)?.message || error
          }`,
        );
      }
    }

    this.logger.log(
      `Comparación de curso: lider=${leaderSent} comparación=${compareSent} emailFallback=${fallbackEmail} omitidos=${skipped} fallidos=${failed}`,
    );
    return { leaderSent, compareSent, fallbackEmail, skipped, failed };
  }

  private async computeCohortStats(
    eventId: string,
  ): Promise<CohortStats | null> {
    const attendees = await this.courseAttendeeService.findByEventId(eventId);
    if (attendees.length < MIN_COHORT_SIZE) return null;

    const progressByUser = new Map<string, number>();
    for (const a of attendees) {
      progressByUser.set(String(a.user_id), a.progress || 0);
    }

    const progresses = Array.from(progressByUser.values());
    const maxProgress = Math.max(...progresses);
    // Nadie ha avanzado todavía: no hay nada útil que comparar
    if (maxProgress <= 0) return null;

    const avgProgress = Math.round(
      progresses.reduce((sum, p) => sum + p, 0) / progresses.length,
    );
    return { avgProgress, maxProgress, progressByUser };
  }

  private async sendRankingFor(
    activity: UserActivity,
    course: CourseTime,
    cohort: CohortStats,
  ): Promise<RankingResult> {
    const userProgress = cohort.progressByUser.get(String(activity.user_id));
    // Usuario con actividad esta semana pero sin inscripción en
    // course-attendee para este curso: no hay progreso que comparar.
    if (userProgress === undefined) return 'skipped';

    const [user, orgUser] = await Promise.all([
      this.usersService.findById(activity.user_id).catch(() => null),
      this.organizationUsersService
        .findByUserAndOrg(activity.user_id, activity.organization_id)
        .catch(() => null),
    ]);

    const phone = resolvePhone(orgUser, user);
    if (!phone) return 'skipped';

    const organization = await this.organizationsService
      .findOne(activity.organization_id)
      .catch(() => null);
    if (!organization) return 'skipped';

    const userName = resolveName(orgUser, user);
    const email = resolveEmail(orgUser, user);
    const courseName = course.course_name || 'tu curso';
    const courseUrl = `${this.baseUrl}/organization/${activity.organization_id}/course/${course.event_id}`;
    const isLeader = userProgress >= cohort.maxProgress;

    const fallbackFields = email
      ? {
          fallbackEmail: email,
          fallbackSubject: isLeader
            ? `¡Vas liderando ${courseName}!`
            : `Sigue avanzando en ${courseName}`,
          fallbackHtml: this.renderFallbackEmailHtml(
            userName,
            courseName,
            userProgress,
            cohort.avgProgress,
            courseUrl,
            isLeader,
          ),
        }
      : {};

    // Plantillas de Meta esperadas:
    // - ranking_lider_curso: {{1}} nombre, {{2}} curso, {{3}} % avance, {{4}} link
    // - ranking_comparativo_curso: {{1}} nombre, {{2}} curso, {{3}} % avance propio,
    //   {{4}} % promedio del grupo, {{5}} link
    const result = await this.whatsappGateway.sendTemplate(
      isLeader
        ? {
            to: phone,
            templateName: 'ranking_lider_curso',
            parameters: [userName, courseName, `${userProgress}%`, courseUrl],
            languageCode: 'es',
            ...fallbackFields,
          }
        : {
            to: phone,
            templateName: 'ranking_comparativo_curso',
            parameters: [
              userName,
              courseName,
              `${userProgress}%`,
              `${cohort.avgProgress}%`,
              courseUrl,
            ],
            languageCode: 'es',
            ...fallbackFields,
          },
    );

    if (result === 'fallback_email') {
      this.logger.warn(
        `WhatsApp falló para user_id=${activity.user_id}; se envió email de respaldo a ${email}`,
      );
      return 'fallback_email';
    }
    return isLeader ? 'sent_leader' : 'sent_compare';
  }

  private renderFallbackEmailHtml(
    userName: string,
    courseName: string,
    userProgress: number,
    avgProgress: number,
    courseUrl: string,
    isLeader: boolean,
  ): string {
    const body = isLeader
      ? `<p>Vas liderando <strong>${courseName}</strong> con <strong>${userProgress}%</strong> de avance. ¡Sigue así!</p>`
      : `<p>Tu avance en <strong>${courseName}</strong> es de <strong>${userProgress}%</strong>. El promedio del grupo va en <strong>${avgProgress}%</strong>.</p>`;

    return `
      <p>Hola ${userName},</p>
      ${body}
      <p><a href="${courseUrl}">Continuar el curso</a></p>
    `;
  }

  private pickFeaturedCourse(activity: UserActivity): CourseTime | null {
    const courses = activity.courses || [];
    if (!courses.length) return null;
    return courses.reduce((latest, c) =>
      new Date(c.last_updated) > new Date(latest.last_updated) ? c : latest,
    );
  }
}
