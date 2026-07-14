import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import { UserActivityService } from 'src/user-activity/user-activity.service';
import { UsersService } from 'src/users/users.service';
import { OrganizationsService } from 'src/organizations/organizations.service';
import { OrganizationUsersService } from 'src/organization-users/organization-users.service';
import { OrganizationUser } from 'src/organization-users/schemas/organization-user.schema';
import { UserActivity } from 'src/user-activity/schemas/user-activity.schema';

interface ReminderItem {
  name: string;
  path: string;
}

@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  private readonly gatewayUrl: string;
  private readonly accountId: string;
  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly baseUrl: string;

  constructor(
    private readonly userActivityService: UserActivityService,
    private readonly usersService: UsersService,
    private readonly organizationsService: OrganizationsService,
    private readonly organizationUsersService: OrganizationUsersService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.gatewayUrl = this.configService.get<string>('WHATSAPP_GATEWAY_URL');
    this.accountId =
      this.configService.get<string>('WHATSAPP_GATEWAY_ACCOUNT_ID') ||
      'gencampus';
    this.phoneNumberId = this.configService.get<string>(
      'WHATSAPP_GATEWAY_PHONE_NUMBER_ID',
    );
    this.accessToken = this.configService.get<string>(
      'WHATSAPP_GATEWAY_ACCESS_TOKEN',
    );
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
    if (!this.gatewayUrl) {
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
      await this.registerGatewayAccount();
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

  private async registerGatewayAccount(): Promise<void> {
    if (!this.phoneNumberId || !this.accessToken) {
      this.logger.warn(
        'WHATSAPP_GATEWAY_PHONE_NUMBER_ID/ACCESS_TOKEN no configurados, se omite el registro de cuenta',
      );
      return;
    }
    try {
      await lastValueFrom(
        this.httpService.post(`${this.gatewayUrl}/api/account/register`, {
          accountId: this.accountId,
          phoneNumberId: this.phoneNumberId,
          accessToken: this.accessToken,
        }),
      );
    } catch (error) {
      this.logger.error(
        `No se pudo registrar la cuenta '${this.accountId}' en el gateway de WhatsApp: ${
          (error as any)?.message || error
        }`,
      );
    }
  }

  private async sendReminderFor(
    activity: UserActivity,
  ): Promise<'sent' | 'fallback_email' | 'skipped'> {
    // Los datos de contacto viven en la membresía (organizationusers.properties);
    // el documento de users casi nunca tiene phone y queda solo como fallback.
    const [user, orgUser] = await Promise.all([
      this.usersService.findById(activity.user_id).catch(() => null),
      this.organizationUsersService
        .findByUserAndOrg(activity.user_id, activity.organization_id)
        .catch(() => null),
    ]);

    const phone = this.resolvePhone(orgUser, user);
    if (!phone) return 'skipped';

    const organization = await this.organizationsService
      .findOne(activity.organization_id)
      .catch(() => null);
    if (!organization) return 'skipped';

    const lastItem = this.pickLastItem(activity);
    if (!lastItem) return 'skipped';

    const itemUrl = `${this.baseUrl}/organization/${activity.organization_id}/${lastItem.path}`;
    const userName = this.resolveName(orgUser, user);
    const email = orgUser?.properties?.email || user?.email || null;

    // Si WhatsApp falla, el gateway envía este email como respaldo
    // (requiere fallbackEmail + fallbackSubject + fallbackHtml)
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

    try {
      await lastValueFrom(
        this.httpService.post(`${this.gatewayUrl}/api/send-template`, {
          accountId: this.accountId,
          to: phone,
          templateName: 'recordatorio_inactividad_3dias',
          parameters: [userName, lastItem.name, itemUrl],
          languageCode: 'es',
          ...fallbackFields,
        }),
      );
      return 'sent';
    } catch (error) {
      // El gateway responde 500 cuando WhatsApp falla, pero indica si
      // alcanzó a enviar el email de respaldo
      if ((error as any)?.response?.data?.fallbackEmailSent === true) {
        this.logger.warn(
          `WhatsApp falló para user_id=${activity.user_id}; se envió email de respaldo a ${email}`,
        );
        return 'fallback_email';
      }
      throw error;
    }
  }

  /**
   * El teléfono de la membresía viene sin indicativo (ej. "3132735116" +
   * indicativodepais "+57"); Meta espera solo dígitos con el país adelante.
   * Solo se antepone el indicativo si el número no lo trae ya.
   */
  private resolvePhone(
    orgUser: OrganizationUser | null,
    user: any,
  ): string | null {
    const rawPhone = String(orgUser?.properties?.phone ?? '').replace(
      /\D/g,
      '',
    );
    const prefix = String(orgUser?.properties?.indicativodepais ?? '').replace(
      /\D/g,
      '',
    );

    if (rawPhone) {
      const alreadyPrefixed =
        prefix && rawPhone.startsWith(prefix) && rawPhone.length > 10;
      if (prefix && !alreadyPrefixed) return `${prefix}${rawPhone}`;
      return rawPhone;
    }

    const userPhone = String(user?.phone ?? '').replace(/\D/g, '');
    return userPhone || null;
  }

  private resolveName(orgUser: OrganizationUser | null, user: any): string {
    const props = orgUser?.properties ?? {};
    const fullName = [props.nombres, props.apellidos]
      .filter(Boolean)
      .join(' ')
      .trim();
    return fullName || props.names || user?.names || 'estudiante';
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
