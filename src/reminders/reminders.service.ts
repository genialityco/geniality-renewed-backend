import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserActivityService } from 'src/user-activity/user-activity.service';
import { UsersService } from 'src/users/users.service';
import { OrganizationsService } from 'src/organizations/organizations.service';
import { OrganizationUsersService } from 'src/organization-users/organization-users.service';
import { UserActivity } from 'src/user-activity/schemas/user-activity.schema';
import { WhatsappGatewayClient } from './whatsapp-gateway.client';
import {
  maskPhone,
  resolveEmail,
  resolveName,
  resolvePhone,
  sanitizeOrganizationId,
} from './contact.util';
import { hasWhatsappConsent } from 'src/common/whatsapp-consent';
import { CourseAttendeeService } from 'src/course-attendee/course-attendee.service';
import { EngagementLogService } from 'src/engagement/engagement-log.service';
import { GenOnProgramsService } from 'src/genon/genon-programs.service';

interface ReminderItem {
  name: string;
  path: string;
  eventId: string | null;
}

export interface TestUserContact {
  user_id: string;
  name: string;
  email: string;
  has_phone: boolean;
  phone_masked: string | null;
  /** Consentimiento efectivo: el job real le podría escribir */
  whatsapp_consent: boolean;
  opted_out: boolean;
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
    private readonly courseAttendeeService: CourseAttendeeService,
    private readonly engagementLog: EngagementLogService,
    private readonly genonPrograms: GenOnProgramsService,
  ) {
    this.baseUrl =
      this.configService.get<string>('WHATSAPP_REMINDER_BASE_URL') ||
      'https://app.geniality.com.co';
  }

  /**
   * Miembros de la organización para probar plantillas con datos reales:
   * solo lo necesario para elegirlos (sin exponer el teléfono completo) y si
   * el job real les podría escribir (teléfono + consentimiento).
   */
  async searchTestUsers(
    organizationId: string,
    search: string,
  ): Promise<TestUserContact[]> {
    const s = String(search ?? '').trim();
    if (s.length < 2) return [];
    const [{ results }, organization] = await Promise.all([
      this.organizationUsersService.findByOrganizationId(
        organizationId,
        1,
        10,
        // El servicio lo usa como regex: se escapa para buscar texto literal
        s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      ),
      this.organizationsService.findOne(organizationId).catch(() => null),
    ]);
    return results.map((orgUser) =>
      this.describeContact(
        orgUser,
        null,
        organization?.whatsapp_consent_property,
      ),
    );
  }

  /** Contacto de un usuario de la organización (para la vista previa). */
  async getTestUserContact(
    organizationId: string,
    userId: string,
  ): Promise<TestUserContact | null> {
    const [orgUser, user, organization] = await Promise.all([
      this.organizationUsersService
        .findByUserAndOrg(userId, organizationId)
        .catch(() => null),
      this.usersService.findById(userId).catch(() => null),
      this.organizationsService.findOne(organizationId).catch(() => null),
    ]);
    if (!orgUser) return null;
    return this.describeContact(
      orgUser,
      user,
      organization?.whatsapp_consent_property,
    );
  }

  private describeContact(
    orgUser: any,
    user: any,
    consentProperty?: string | null,
  ): TestUserContact {
    const phone = resolvePhone(orgUser, user);
    const userId = orgUser.user_id?._id ?? orgUser.user_id;
    return {
      user_id: String(userId),
      name: resolveName(orgUser, user),
      email: resolveEmail(orgUser, user) || '',
      has_phone: Boolean(phone),
      phone_masked: maskPhone(phone),
      whatsapp_consent: hasWhatsappConsent(orgUser, consentProperty),
      opted_out: Boolean(orgUser.whatsapp_opt_out_at),
    };
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
        (a) =>
          sanitizeOrganizationId(a.organization_id) === filter.organizationId,
      );
    }
    this.logger.log(
      `Encontrados ${staleActivities.length} registros en ventana de inactividad de 3 días`,
    );

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

  /**
   * Arma los parámetros de "recordatorio_inactividad_3dias" con los datos
   * reales del usuario (su actividad más reciente en scopeOrganizationId, o en
   * cualquier organización si no se indica), sin enviar nada. Lo usa el endpoint de prueba de
   * plantillas para previsualizar el mensaje a partir de un userId.
   */
  async buildInactivityReminderParams(
    userId: string,
    scopeOrganizationId?: string,
  ): Promise<{
    parameters: string[];
    buttonUrl: string;
    fallbackEmail?: string;
  } | null> {
    const activity = await this.userActivityService.findLatestByUserId(
      userId,
      scopeOrganizationId,
    );
    if (!activity) return null;

    const organizationId = sanitizeOrganizationId(activity.organization_id);

    const [user, orgUser] = await Promise.all([
      this.usersService.findById(activity.user_id).catch(() => null),
      this.organizationUsersService
        .findByUserAndOrg(activity.user_id, organizationId)
        .catch(() => null),
    ]);

    const organization = await this.organizationsService
      .findOne(organizationId)
      .catch(() => null);
    if (!organization) return null;

    const completed = await this.courseAttendeeService.findCompletedEventIds(
      String(activity.user_id),
    );
    const lastItem = this.pickLastItem(activity, completed);
    if (!lastItem) return null;

    const userName = resolveName(orgUser, user);
    const email = resolveEmail(orgUser, user);

    return {
      parameters: [userName, organization.name, lastItem.name],
      // La plantilla de WhatsApp ya tiene fijo el dominio + "/organization/"
      // en el botón; acá solo va lo que falta, no la URL completa.
      buttonUrl: `${organizationId}/${lastItem.path}`,
      fallbackEmail: email || undefined,
    };
  }

  private async sendReminderFor(
    activity: UserActivity,
  ): Promise<'sent' | 'fallback_email' | 'skipped'> {
    const organizationId = sanitizeOrganizationId(activity.organization_id);
    // Las organizaciones con Gen.ON activo reciben sus mensajes, no estos
    if ((await this.genonPrograms.managedOrganizationIds()).has(organizationId)) {
      return 'skipped';
    }

    const [user, orgUser] = await Promise.all([
      this.usersService.findById(activity.user_id).catch(() => null),
      this.organizationUsersService
        .findByUserAndOrg(activity.user_id, organizationId)
        .catch(() => null),
    ]);

    const phone = resolvePhone(orgUser, user);
    if (!phone) return 'skipped';

    const organization = await this.organizationsService
      .findOne(organizationId)
      .catch(() => null);
    if (!organization) return 'skipped';

    // Meta exige consentimiento para mensajes iniciados por la plataforma
    if (
      !hasWhatsappConsent(orgUser, organization.whatsapp_consent_property)
    ) {
      return 'skipped';
    }

    const completed = await this.courseAttendeeService.findCompletedEventIds(
      String(activity.user_id),
    );
    const lastItem = this.pickLastItem(activity, completed);
    if (!lastItem) return 'skipped';

    const itemUrl = `${this.baseUrl}/organization/${organizationId}/${lastItem.path}`;
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

    // Plantilla de Meta esperada: {{1}} nombre, {{2}} organización,
    // {{3}} curso/actividad; el botón de la plantilla ya trae fijo el
    // dominio + "/organization/", buttonUrl solo lleva lo que falta.
    // Un recordatorio por episodio de inactividad: last_updated solo cambia
    // si el usuario vuelve, así que un reenvío manual o una segunda corrida
    // del cron no lo duplican.
    const result = await this.engagementLog.deliver(
      {
        dedupeKey: `inactivity:${activity.user_id}:${organizationId}:${new Date(
          activity.last_updated,
        ).toISOString()}`,
        kind: 'inactivity_reminder',
        userId: String(activity.user_id),
        organizationId,
        eventId: lastItem.eventId,
        template: 'recordatorio_inactividad_3dias',
        phone,
      },
      (ref) =>
        this.whatsappGateway.sendTemplateWithId({
          to: phone,
          templateName: 'recordatorio_inactividad_3dias',
          parameters: [userName, organization.name, lastItem.name],
          buttonUrl: this.engagementLog.withClickRef(
            `${organizationId}/${lastItem.path}`,
            ref,
          ),
          languageCode: 'es',
          ...fallbackFields,
        }),
    );
    if (result !== 'sent' && result !== 'fallback_email') return 'skipped';

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

  /**
   * Lo último que vio el usuario, sin contar los cursos que ya completó (a
   * quien terminó no se le dice "te esperamos de vuelta"). Si solo le quedan
   * cursos completados, no hay nada que recordarle.
   */
  private pickLastItem(
    activity: UserActivity,
    completedEventIds: Set<string>,
  ): ReminderItem | null {
    const pending = <T extends { event_id: string }>(items: T[]) =>
      items.filter((i) => !completedEventIds.has(String(i.event_id)));
    const latestCourse = this.latestByLastUpdated(
      pending(activity.courses || []),
    );
    const latestActivity = this.latestByLastUpdated(
      pending(activity.activities || []),
    );

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
        eventId: latestCourse.event_id || null,
      };
    }

    return {
      name: latestActivity.activity_name || 'tu actividad',
      path: `activitydetail/${latestActivity.activity_id}`,
      eventId: latestActivity.event_id || null,
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
