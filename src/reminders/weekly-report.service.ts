import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UserActivityService } from 'src/user-activity/user-activity.service';
import { UsersService } from 'src/users/users.service';
import { OrganizationsService } from 'src/organizations/organizations.service';
import { OrganizationUsersService } from 'src/organization-users/organization-users.service';
import { UserActivity } from 'src/user-activity/schemas/user-activity.schema';
import { UserActivitySnapshot } from './schemas/user-activity-snapshot.schema';
import { WhatsappGatewayClient } from './whatsapp-gateway.client';
import { resolveEmail, resolveName, resolvePhone } from './contact.util';

interface DeltaItem {
  name: string;
  path: string;
  deltaMs: number;
}

// Por debajo de este delta no vale la pena mandar reporte ("0 min")
const MIN_REPORTABLE_MS = 60 * 1000;

@Injectable()
export class WeeklyReportService {
  private readonly logger = new Logger(WeeklyReportService.name);

  private readonly baseUrl: string;

  constructor(
    @InjectModel(UserActivitySnapshot.name)
    private readonly snapshotModel: Model<UserActivitySnapshot>,
    private readonly userActivityService: UserActivityService,
    private readonly usersService: UsersService,
    private readonly organizationsService: OrganizationsService,
    private readonly organizationUsersService: OrganizationUsersService,
    private readonly whatsappGateway: WhatsappGatewayClient,
    private readonly configService: ConfigService,
  ) {
    this.baseUrl =
      this.configService.get<string>('WHATSAPP_REMINDER_BASE_URL') ||
      'https://app.geniality.com.co';
  }

  /**
   * Envía el reporte semanal de tiempo de estudio a los usuarios con
   * actividad reciente. El tiempo reportado es el acumulado actual menos el
   * último snapshot ("desde tu último reporte"); si el usuario nunca ha
   * recibido reporte, la línea base es 0 y se reporta todo lo que lleva —
   * así quien apenas inicia un curso entra solo al siguiente ciclo semanal.
   */
  async sendWeeklyReports(filter?: {
    userId?: string;
    organizationId?: string;
  }): Promise<{
    sent: number;
    fallbackEmail: number;
    skipped: number;
    failed: number;
  }> {
    if (!this.whatsappGateway.isConfigured) {
      this.logger.warn(
        'WHATSAPP_GATEWAY_URL no configurado, se omite el reporte semanal',
      );
      return { sent: 0, fallbackEmail: 0, skipped: 0, failed: 0 };
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
    this.logger.log(
      `Encontrados ${recentActivities.length} registros con actividad en los últimos 7 días`,
    );

    if (recentActivities.length > 0) {
      await this.whatsappGateway.registerAccount();
    }

    let sent = 0;
    let fallbackEmail = 0;
    let skipped = 0;
    let failed = 0;

    for (const activity of recentActivities) {
      try {
        const result = await this.sendReportFor(activity);
        if (result === 'sent') sent++;
        else if (result === 'fallback_email') fallbackEmail++;
        else skipped++;
      } catch (error) {
        failed++;
        this.logger.error(
          `Error enviando reporte semanal para user_id=${activity.user_id}: ${
            (error as any)?.message || error
          }`,
        );
      }
    }

    this.logger.log(
      `Reporte semanal: enviados=${sent} emailFallback=${fallbackEmail} omitidos=${skipped} fallidos=${failed}`,
    );
    return { sent, fallbackEmail, skipped, failed };
  }

  private async sendReportFor(
    activity: UserActivity,
  ): Promise<'sent' | 'fallback_email' | 'skipped'> {
    const snapshot = await this.snapshotModel
      .findOne({
        user_id: activity.user_id,
        organization_id: activity.organization_id,
      })
      .sort({ taken_at: -1 });

    const courseDeltas = this.computeCourseDeltas(activity, snapshot);
    const activityDeltas = this.computeActivityDeltas(activity, snapshot);

    // El tracker del frontend suma el tiempo de una actividad también al
    // curso al que pertenece (el contador de cursos es el superconjunto),
    // así que sumar ambos duplicaría; max() cubre además el caso de
    // actividades rastreadas sin courseId.
    const courseTotal = this.sumDeltas(courseDeltas);
    const activityTotal = this.sumDeltas(activityDeltas);
    const weeklyTotalMs = Math.max(courseTotal, activityTotal);

    if (weeklyTotalMs < MIN_REPORTABLE_MS) return 'skipped';

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

    const featured = this.pickFeaturedItem(courseDeltas, activityDeltas);
    if (!featured) return 'skipped';

    const itemUrl = `${this.baseUrl}/organization/${activity.organization_id}/${featured.path}`;
    const userName = resolveName(orgUser, user);
    const email = resolveEmail(orgUser, user);
    const timeText = this.formatDuration(weeklyTotalMs);

    const fallbackFields = email
      ? {
          fallbackEmail: email,
          fallbackSubject: `Tu resumen semanal en ${organization.name}`,
          fallbackHtml: this.renderFallbackEmailHtml(
            userName,
            timeText,
            courseDeltas,
            itemUrl,
            organization.name,
          ),
        }
      : {};

    // Plantilla de Meta esperada: {{1}} nombre, {{2}} tiempo de la semana,
    // {{3}} curso/actividad destacada, {{4}} link para continuar
    const result = await this.whatsappGateway.sendTemplate({
      to: phone,
      templateName: 'reporte_semanal_progreso',
      parameters: [userName, timeText, featured.name, itemUrl],
      languageCode: 'es',
      ...fallbackFields,
    });

    if (result === 'fallback_email') {
      this.logger.warn(
        `WhatsApp falló para user_id=${activity.user_id}; se envió email de respaldo a ${email}`,
      );
    }

    // Solo se toma snapshot cuando el reporte se entregó: lo omitido o
    // fallido se arrastra al siguiente reporte en vez de perderse.
    await this.saveSnapshot(activity);
    return result;
  }

  private computeCourseDeltas(
    activity: UserActivity,
    snapshot: UserActivitySnapshot | null,
  ): DeltaItem[] {
    const previous = new Map<string, number>();
    for (const c of snapshot?.courses || []) {
      previous.set(`${c.course_id}_${c.event_id}`, c.time_spent_ms || 0);
    }
    return (activity.courses || []).map((c) => ({
      name: c.course_name || 'tu curso',
      path: `course/${c.event_id}`,
      deltaMs: Math.max(
        0,
        (c.time_spent_ms || 0) -
          (previous.get(`${c.course_id}_${c.event_id}`) || 0),
      ),
    }));
  }

  private computeActivityDeltas(
    activity: UserActivity,
    snapshot: UserActivitySnapshot | null,
  ): DeltaItem[] {
    const previous = new Map<string, number>();
    for (const a of snapshot?.activities || []) {
      previous.set(`${a.activity_id}_${a.event_id}`, a.time_spent_ms || 0);
    }
    return (activity.activities || []).map((a) => ({
      name: a.activity_name || 'tu actividad',
      path: `activitydetail/${a.activity_id}`,
      deltaMs: Math.max(
        0,
        (a.time_spent_ms || 0) -
          (previous.get(`${a.activity_id}_${a.event_id}`) || 0),
      ),
    }));
  }

  private sumDeltas(items: DeltaItem[]): number {
    return items.reduce((sum, i) => sum + i.deltaMs, 0);
  }

  /**
   * El ítem con mayor tiempo de la semana es el destacado del mensaje;
   * en empate gana el curso (su link agrupa a sus actividades).
   */
  private pickFeaturedItem(
    courseDeltas: DeltaItem[],
    activityDeltas: DeltaItem[],
  ): DeltaItem | null {
    const topCourse = this.maxByDelta(courseDeltas);
    const topActivity = this.maxByDelta(activityDeltas);

    if (!topCourse && !topActivity) return null;
    if (
      topCourse &&
      (!topActivity || topCourse.deltaMs >= topActivity.deltaMs)
    ) {
      return topCourse;
    }
    return topActivity;
  }

  private maxByDelta(items: DeltaItem[]): DeltaItem | null {
    const withTime = items.filter((i) => i.deltaMs > 0);
    if (!withTime.length) return null;
    return withTime.reduce((max, item) =>
      item.deltaMs > max.deltaMs ? item : max,
    );
  }

  // Meta rechaza saltos de línea en los parámetros de plantilla,
  // así que el texto debe quedar en una sola línea
  private formatDuration(ms: number): string {
    const totalMinutes = Math.round(ms / 60000);
    if (totalMinutes < 1) return 'menos de 1 min';
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `${minutes} min`;
    if (minutes === 0) return `${hours} h`;
    return `${hours} h ${minutes} min`;
  }

  private renderFallbackEmailHtml(
    userName: string,
    timeText: string,
    courseDeltas: DeltaItem[],
    itemUrl: string,
    organizationName: string,
  ): string {
    const breakdown = courseDeltas
      .filter((c) => c.deltaMs > 0)
      .sort((a, b) => b.deltaMs - a.deltaMs)
      .map(
        (c) =>
          `<li><strong>${c.name}</strong>: ${this.formatDuration(c.deltaMs)}</li>`,
      )
      .join('');

    return `
      <p>Hola ${userName},</p>
      <p>Esta semana dedicaste <strong>${timeText}</strong> a tu aprendizaje en <strong>${organizationName}</strong>.</p>
      ${breakdown ? `<p>Así se repartió tu tiempo:</p><ul>${breakdown}</ul>` : ''}
      <p><a href="${itemUrl}">Continuar aprendiendo</a></p>
    `;
  }

  private async saveSnapshot(activity: UserActivity): Promise<void> {
    await this.snapshotModel.create({
      user_id: activity.user_id,
      organization_id: activity.organization_id,
      taken_at: new Date(),
      total_courses_time_ms: activity.total_courses_time_ms || 0,
      total_activities_time_ms: activity.total_activities_time_ms || 0,
      courses: (activity.courses || []).map((c) => ({
        course_id: c.course_id,
        event_id: c.event_id,
        course_name: c.course_name,
        time_spent_ms: c.time_spent_ms || 0,
      })),
      activities: (activity.activities || []).map((a) => ({
        activity_id: a.activity_id,
        event_id: a.event_id,
        activity_name: a.activity_name,
        time_spent_ms: a.time_spent_ms || 0,
      })),
    });
  }
}
