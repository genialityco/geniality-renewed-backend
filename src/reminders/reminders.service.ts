import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserActivityService } from 'src/user-activity/user-activity.service';
import { UsersService } from 'src/users/users.service';
import { OrganizationsService } from 'src/organizations/organizations.service';
import { OrganizationUsersService } from 'src/organization-users/organization-users.service';
import { UserActivity } from 'src/user-activity/schemas/user-activity.schema';
import { WhatsappGatewayClient } from './whatsapp-gateway.client';
import { resolveEmail, resolveName, resolvePhone } from './contact.util';

interface ReminderItem {
  name: string;
  path: string;
}

@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  private readonly baseUrl: string;

  constructor(
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
   * Busca usuarios que cruzaron el umbral de 3 días de inactividad
   * (ventana de un día para no reenviar el mismo recordatorio cada corrida)
   * y les manda un WhatsApp con la última actividad/curso visto.
   */
  async sendInactivityReminders(filter?: {
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
        'WHATSAPP_GATEWAY_URL no configurado, se omite el envío de recordatorios',
      );
      return { sent: 0, fallbackEmail: 0, skipped: 0, failed: 0 };
    }

    let staleActivities = await this.userActivityService.findInactiveWindow(3);

    // Filtro opcional para pruebas/reenvíos dirigidos a un usuario u org
    if (filter?.userId) {
      staleActivities = staleActivities.filter(
        (a) => String(a.user_id) === filter.userId,
      );
    }
    if (filter?.organizationId) {
      staleActivities = staleActivities.filter(
        (a) => String(a.organization_id) === filter.organizationId,
      );
    }
    this.logger.log(
      `Encontrados ${staleActivities.length} registros en ventana de inactividad de 3 días`,
    );

    if (staleActivities.length > 0) {
      await this.whatsappGateway.registerAccount();
    }

    let sent = 0;
    let fallbackEmail = 0;
    let skipped = 0;
    let failed = 0;

    for (const activity of staleActivities) {
      try {
        const result = await this.sendReminderFor(activity);
        if (result === 'sent') sent++;
        else if (result === 'fallback_email') fallbackEmail++;
        else skipped++;
      } catch (error) {
        failed++;
        this.logger.error(
          `Error enviando recordatorio para user_id=${activity.user_id}: ${
            (error as any)?.message || error
          }`,
        );
      }
    }

    this.logger.log(
      `Recordatorios de inactividad: enviados=${sent} emailFallback=${fallbackEmail} omitidos=${skipped} fallidos=${failed}`,
    );
    return { sent, fallbackEmail, skipped, failed };
  }

  private async sendReminderFor(
    activity: UserActivity,
  ): Promise<'sent' | 'fallback_email' | 'skipped'> {
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

    const lastItem = this.pickLastItem(activity);
    if (!lastItem) return 'skipped';

    const itemUrl = `${this.baseUrl}/organization/${activity.organization_id}/${lastItem.path}`;
    const userName = resolveName(orgUser, user);
    const email = resolveEmail(orgUser, user);

    const fallbackFields = email
      ? {
          fallbackEmail: email,
          fallbackSubject: `Te esperamos de vuelta en ${organization.name}`,
          fallbackHtml: this.renderFallbackEmailHtml(
            userName,
            lastItem.name,
            itemUrl,
            organization.name,
          ),
        }
      : {};

    const result = await this.whatsappGateway.sendTemplate({
      to: phone,
      templateName: 'recordatorio_inactividad_3dias',
      parameters: [userName, lastItem.name, itemUrl],
      languageCode: 'es',
      ...fallbackFields,
    });

    if (result === 'fallback_email') {
      this.logger.warn(
        `WhatsApp falló para user_id=${activity.user_id}; se envió email de respaldo a ${email}`,
      );
    }
    return result;
  }

  private renderFallbackEmailHtml(
    userName: string,
    itemName: string,
    itemUrl: string,
    organizationName: string,
  ): string {
    return `
      <p>Hola ${userName},</p>
      <p>Hace unos días no te vemos por <strong>${organizationName}</strong>.</p>
      <p>Te esperamos para que continúes donde quedaste: <strong>${itemName}</strong>.</p>
      <p><a href="${itemUrl}">Continuar ahora</a></p>
    `;
  }

  private pickLastItem(activity: UserActivity): ReminderItem | null {
    const latestCourse = this.latestByLastUpdated(activity.courses || []);
    const latestActivity = this.latestByLastUpdated(activity.activities || []);

    if (!latestCourse && !latestActivity) return null;

    if (
      latestCourse &&
      (!latestActivity ||
        new Date(latestCourse.last_updated) >=
          new Date(latestActivity.last_updated))
    ) {
      return {
        name: latestCourse.course_name || 'tu curso',
        path: `course/${latestCourse.event_id}`,
      };
    }

    return {
      name: latestActivity.activity_name || 'tu actividad',
      path: `activitydetail/${latestActivity.activity_id}`,
    };
  }

  private latestByLastUpdated<T extends { last_updated: Date }>(
    items: T[],
  ): T | null {
    if (!items.length) return null;
    return items.reduce((latest, item) =>
      new Date(item.last_updated) > new Date(latest.last_updated)
        ? item
        : latest,
    );
  }
}
