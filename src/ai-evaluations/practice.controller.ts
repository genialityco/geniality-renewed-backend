import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionTokenGuard } from 'src/auth/session-token.guard';
import { OrgMembershipGuard } from 'src/auth/org-membership.guard';
import { OrgAdminGuard } from 'src/auth/org-admin.guard';
import {
  PracticeSendBody,
  PracticeSessionsService,
} from './practice-sessions.service';

/**
 * Simulacros de práctica por WhatsApp con el banco de preguntas por
 * actividad: consentimiento del estudiante y envío manual desde el admin.
 */
@Controller('whatsapp-practice')
export class PracticeController {
  constructor(private readonly service: PracticeSessionsService) {}

  // ─── Estudiante ────────────────────────────────────────────────────────

  /** GET /whatsapp-practice/me/organization/:organizationId/opt-in */
  @UseGuards(SessionTokenGuard, OrgMembershipGuard)
  @Get('me/organization/:organizationId/opt-in')
  async getOptIn(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
  ) {
    return this.service.getOptIn(req.auth.uid, organizationId);
  }

  /** PUT /whatsapp-practice/me/organization/:organizationId/opt-in  { opt_in } */
  @UseGuards(SessionTokenGuard, OrgMembershipGuard)
  @Put('me/organization/:organizationId/opt-in')
  async setOptIn(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Body() body: { opt_in?: boolean },
  ) {
    return this.service.setOptIn(
      req.auth.uid,
      organizationId,
      Boolean(body?.opt_in),
    );
  }

  // ─── Admin ─────────────────────────────────────────────────────────────

  /** GET /whatsapp-practice/admin-organizations — organizaciones que administra el usuario */
  @UseGuards(SessionTokenGuard)
  @Get('admin-organizations')
  async adminOrganizations(@Req() req: any) {
    return this.service.adminOrganizations(req.auth.uid);
  }

  /**
   * POST /whatsapp-practice/organization/:organizationId/preview
   * Body: { email, min_progress?, event_ids? }
   */
  @UseGuards(SessionTokenGuard, OrgAdminGuard)
  @Post('organization/:organizationId/preview')
  async preview(
    @Param('organizationId') organizationId: string,
    @Body() body: PracticeSendBody,
  ) {
    return this.service.preview(organizationId, body || {});
  }

  /**
   * POST /whatsapp-practice/organization/:organizationId/send
   * Body: { email, num_questions?, min_progress?, event_ids? }
   */
  @UseGuards(SessionTokenGuard, OrgAdminGuard)
  @Post('organization/:organizationId/send')
  async send(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Body() body: PracticeSendBody,
  ) {
    return this.service.send(organizationId, body || {}, req.auth.uid);
  }

  /** GET /whatsapp-practice/organization/:organizationId/sessions?email= */
  @UseGuards(SessionTokenGuard, OrgAdminGuard)
  @Get('organization/:organizationId/sessions')
  async list(
    @Param('organizationId') organizationId: string,
    @Query('email') email?: string,
  ) {
    return this.service.listSessions(organizationId, email);
  }

  /** GET /whatsapp-practice/organization/:organizationId/sessions/:sessionId */
  @UseGuards(SessionTokenGuard, OrgAdminGuard)
  @Get('organization/:organizationId/sessions/:sessionId')
  async detail(
    @Param('organizationId') organizationId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.service.getSession(organizationId, sessionId);
  }
}
