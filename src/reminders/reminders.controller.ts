import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SessionTokenGuard } from '../auth/session-token.guard';
import { OrgAdminGuard } from '../auth/org-admin.guard';
import { RemindersService } from './reminders.service';
import { WeeklyReportService } from './weekly-report.service';
import { CourseRankingService } from './course-ranking.service';
import { WhatsappGatewayClient } from './whatsapp-gateway.client';

const TEMPLATE_NAMES = [
  'recordatorio_inactividad_3dias',
  'reporte_semanal_progreso',
  'ranking_lider_curso1',
  'ranking_comparativo_curso1',
] as const;
type TemplateName = (typeof TEMPLATE_NAMES)[number];

// Endpoints para disparar los jobs manualmente (el cron llama a los
// servicios directamente, sin pasar por aquí). Solo administradores y
// siempre acotados a la organización de la ruta: antes bastaba cualquier
// sesión para disparar envíos masivos de todas las organizaciones.
@UseGuards(SessionTokenGuard, OrgAdminGuard)
@Controller('reminders/organization/:organizationId')
export class RemindersController {
  constructor(
    private readonly remindersService: RemindersService,
    private readonly weeklyReportService: WeeklyReportService,
    private readonly courseRankingService: CourseRankingService,
    private readonly whatsappGateway: WhatsappGatewayClient,
  ) {}

  @Post('inactivity/run')
  async runInactivityCheck(
    @Param('organizationId') organizationId: string,
    @Query('userId') userId?: string,
  ) {
    return this.remindersService.sendInactivityReminders({
      userId,
      organizationId,
    });
  }

  @Post('weekly-report/run')
  async runWeeklyReport(
    @Param('organizationId') organizationId: string,
    @Query('userId') userId?: string,
  ) {
    return this.weeklyReportService.sendWeeklyReports({
      userId,
      organizationId,
    });
  }

  @Post('course-ranking/run')
  async runCourseRanking(
    @Param('organizationId') organizationId: string,
    @Query('userId') userId?: string,
  ) {
    return this.courseRankingService.sendCourseRankingMessages({
      userId,
      organizationId,
    });
  }

  // Lista los nombres de plantilla válidos para /test-template.
  @Get('templates')
  async listTemplates() {
    return TEMPLATE_NAMES;
  }

  // Envía una plantilla a un teléfono de prueba, completando el mensaje
  // con los datos reales del usuario (nombre, organización, último
  // curso/actividad, progreso, etc. según la plantilla elegida). No exige
  // que el usuario cumpla las condiciones del job real (3 días de
  // inactividad, ser líder del curso, etc): arma el mensaje con lo que
  // encuentre y, para las de ranking, deja elegir la variante a previsualizar.
  @Post('test-template')
  async testTemplate(
    @Param('organizationId') organizationId: string,
    @Body('userId') userId?: string,
    @Body('templateName') templateName?: string,
    @Body('to') to?: string,
  ) {
    if (!userId) {
      throw new BadRequestException('El campo "userId" es requerido');
    }
    if (!to) {
      throw new BadRequestException(
        'El campo "to" (teléfono en formato internacional) es requerido',
      );
    }
    if (!TEMPLATE_NAMES.includes(templateName as TemplateName)) {
      throw new BadRequestException(
        `"templateName" inválido. Valores permitidos: ${TEMPLATE_NAMES.join(', ')}`,
      );
    }
    if (!this.whatsappGateway.isConfigured) {
      throw new BadRequestException(
        'WHATSAPP_GATEWAY_URL no está configurado en este ambiente',
      );
    }

    const built = await this.buildParams(
      userId,
      templateName as TemplateName,
      organizationId,
    );
    if (!built) {
      throw new NotFoundException(
        'No se encontró suficiente información de actividad del usuario para armar esta plantilla',
      );
    }

    const result = await this.whatsappGateway.sendTemplate({
      to,
      templateName,
      parameters: built.parameters,
      buttonUrl: built.buttonUrl,
      languageCode: 'es',
      ...(built.fallbackEmail
        ? {
            fallbackEmail: built.fallbackEmail,
            fallbackSubject: 'Mensaje de prueba',
            fallbackHtml: '<p>Este es un mensaje de prueba de plantilla.</p>',
          }
        : {}),
    });

    return { result, templateName, parameters: built.parameters };
  }

  private async buildParams(
    userId: string,
    templateName: TemplateName,
    organizationId: string,
  ): Promise<{
    parameters: string[];
    buttonUrl: string;
    fallbackEmail?: string;
  } | null> {
    switch (templateName) {
      case 'recordatorio_inactividad_3dias':
        return this.remindersService.buildInactivityReminderParams(
          userId,
          organizationId,
        );
      case 'reporte_semanal_progreso':
        return this.weeklyReportService.buildWeeklyReportParams(
          userId,
          organizationId,
        );
      case 'ranking_lider_curso1':
      case 'ranking_comparativo_curso1':
        return this.courseRankingService.buildRankingParams(
          userId,
          templateName,
          organizationId,
        );
    }
  }
}
