import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionTokenGuard } from 'src/auth/session-token.guard';
import { OrgAdminGuard } from 'src/auth/org-admin.guard';
import {
  AiEvaluationsService,
  UpsertContextBody,
} from './ai-evaluations.service';

/**
 * Evaluación de conocimientos por WhatsApp con IA (botón "Evaluar tus
 * conocimientos" del curso) y administración del contexto que usa la IA.
 */
@Controller('ai-evaluations')
export class AiEvaluationsController {
  constructor(private readonly service: AiEvaluationsService) {}

  // ─── Estudiante ────────────────────────────────────────────────────────

  /**
   * POST /ai-evaluations/start
   * Body: { event_id, module_id? }
   * Devuelve { session_id, code, whatsapp_url, expires_at, ... }; el frontend
   * abre whatsapp_url. Con module_id se evalúa ese módulo directamente; sin
   * él, el bot pregunta qué módulo evaluar.
   */
  @UseGuards(SessionTokenGuard)
  @Post('start')
  async start(
    @Req() req: any,
    @Body() body: { event_id?: string; module_id?: string },
  ) {
    if (!body?.event_id) {
      throw new BadRequestException('event_id es requerido');
    }
    return this.service.start(req.auth.uid, body.event_id, body.module_id);
  }

  /**
   * GET /ai-evaluations/event/:eventId/availability
   * { enabled, modules } — el frontend muestra el botón solo si enabled.
   */
  @UseGuards(SessionTokenGuard)
  @Get('event/:eventId/availability')
  async availability(@Param('eventId') eventId: string) {
    return this.service.availability(eventId);
  }

  /** GET /ai-evaluations/me/event/:eventId/results */
  @UseGuards(SessionTokenGuard)
  @Get('me/event/:eventId/results')
  async myResults(@Req() req: any, @Param('eventId') eventId: string) {
    return this.service.findMyResults(req.auth.uid, eventId);
  }

  /** GET /ai-evaluations/me/sessions/:sessionId — historial de la conversación */
  @UseGuards(SessionTokenGuard)
  @Get('me/sessions/:sessionId')
  async mySession(@Req() req: any, @Param('sessionId') sessionId: string) {
    return this.service.findMySession(req.auth.uid, sessionId);
  }

  // ─── Admin ─────────────────────────────────────────────────────────────
  // :moduleKey = id del módulo, o "course" para el contexto de todo el curso.

  /** GET /ai-evaluations/organization/:organizationId/event/:eventId/contexts */
  @UseGuards(SessionTokenGuard, OrgAdminGuard)
  @Get('organization/:organizationId/event/:eventId/contexts')
  async listContexts(
    @Param('organizationId') organizationId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.service.listContexts(organizationId, eventId);
  }

  /** PUT /ai-evaluations/organization/:organizationId/event/:eventId/contexts/:moduleKey */
  @UseGuards(SessionTokenGuard, OrgAdminGuard)
  @Put('organization/:organizationId/event/:eventId/contexts/:moduleKey')
  async upsertContext(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('eventId') eventId: string,
    @Param('moduleKey') moduleKey: string,
    @Body() body: UpsertContextBody,
  ) {
    return this.service.upsertContext(
      organizationId,
      eventId,
      moduleKey,
      body || {},
      req.auth.uid,
    );
  }

  /** DELETE /ai-evaluations/organization/:organizationId/event/:eventId/contexts/:moduleKey */
  @UseGuards(SessionTokenGuard, OrgAdminGuard)
  @Delete('organization/:organizationId/event/:eventId/contexts/:moduleKey')
  async deleteContext(
    @Param('organizationId') organizationId: string,
    @Param('eventId') eventId: string,
    @Param('moduleKey') moduleKey: string,
  ) {
    return this.service.deleteContext(organizationId, eventId, moduleKey);
  }

  /**
   * POST /ai-evaluations/organization/:organizationId/event/:eventId/contexts/:moduleKey/draft
   * Genera (sin guardar) un borrador del contexto a partir del contenido del módulo.
   */
  @UseGuards(SessionTokenGuard, OrgAdminGuard)
  @Post('organization/:organizationId/event/:eventId/contexts/:moduleKey/draft')
  async generateDraft(
    @Param('organizationId') organizationId: string,
    @Param('eventId') eventId: string,
    @Param('moduleKey') moduleKey: string,
  ) {
    return this.service.generateDraft(organizationId, eventId, moduleKey);
  }

  /** GET /ai-evaluations/organization/:organizationId/event/:eventId/results */
  @UseGuards(SessionTokenGuard, OrgAdminGuard)
  @Get('organization/:organizationId/event/:eventId/results')
  async eventResults(
    @Param('organizationId') organizationId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.service.findEventResults(organizationId, eventId);
  }
}
