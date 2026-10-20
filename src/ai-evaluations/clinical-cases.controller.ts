import {
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
import { OrgMembershipGuard } from 'src/auth/org-membership.guard';
import {
  CaseInput,
  ClinicalCasesService,
  GenerateCaseBody,
  GenerateFollowupBody,
  ReviewSessionBody,
} from './clinical-cases.service';

/** Casos clínicos (admin): generar con IA, editar, habilitar y ver intentos. */
@UseGuards(SessionTokenGuard, OrgAdminGuard)
@Controller('clinical-cases/admin/organization/:organizationId')
export class ClinicalCasesAdminController {
  constructor(private readonly service: ClinicalCasesService) {}

  /** GET .../event/:eventId/cases */
  @Get('event/:eventId/cases')
  list(
    @Param('organizationId') organizationId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.service.list(organizationId, eventId);
  }

  /** POST .../event/:eventId/cases/generate  { activity_id?, num_stages?, instructions? } */
  @Post('event/:eventId/cases/generate')
  generate(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('eventId') eventId: string,
    @Body() body: GenerateCaseBody,
  ) {
    return this.service.generate(
      organizationId,
      eventId,
      req.auth.uid,
      body || {},
    );
  }

  @Get('cases/:caseId')
  get(
    @Param('organizationId') organizationId: string,
    @Param('caseId') caseId: string,
  ) {
    return this.service.get(organizationId, caseId);
  }

  @Put('cases/:caseId')
  update(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('caseId') caseId: string,
    @Body() body: CaseInput,
  ) {
    return this.service.update(
      organizationId,
      caseId,
      req.auth.uid,
      body || {},
    );
  }

  /** POST .../cases/:caseId/followup/generate  { years?, num_stages?, instructions? } */
  @Post('cases/:caseId/followup/generate')
  generateFollowup(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('caseId') caseId: string,
    @Body() body: GenerateFollowupBody,
  ) {
    return this.service.generateFollowup(
      organizationId,
      caseId,
      req.auth.uid,
      body || {},
    );
  }

  /** POST .../cases/:caseId/resources — recalcula "dónde estudiarlo" */
  @Post('cases/:caseId/resources')
  refreshResources(
    @Param('organizationId') organizationId: string,
    @Param('caseId') caseId: string,
  ) {
    return this.service.refreshResources(organizationId, caseId);
  }

  @Delete('cases/:caseId')
  remove(
    @Param('organizationId') organizationId: string,
    @Param('caseId') caseId: string,
  ) {
    return this.service.remove(organizationId, caseId);
  }

  /** GET .../cases/:caseId/sessions — intentos de los estudiantes */
  @Get('cases/:caseId/sessions')
  sessions(
    @Param('organizationId') organizationId: string,
    @Param('caseId') caseId: string,
  ) {
    return this.service.caseSessions(organizationId, caseId);
  }

  /** GET .../cases/:caseId/calibration — concordancia IA–docente */
  @Get('cases/:caseId/calibration')
  calibration(
    @Param('organizationId') organizationId: string,
    @Param('caseId') caseId: string,
  ) {
    return this.service.calibration(organizationId, caseId);
  }

  /**
   * PUT .../sessions/:sessionId/review
   * { items: [{ stage, item_id, status }], dismiss_unsafe?, dismiss_unnecessary?, note? }
   */
  @Put('sessions/:sessionId/review')
  review(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: ReviewSessionBody,
  ) {
    return this.service.reviewSession(
      organizationId,
      sessionId,
      req.auth.uid,
      body || {},
    );
  }

  /** GET .../sessions/:sessionId — conversación + evaluación oculta */
  @Get('sessions/:sessionId')
  session(
    @Param('organizationId') organizationId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.service.adminSession(organizationId, sessionId);
  }
}

/** Casos clínicos (estudiante): resolver con el tutor socrático. */
@UseGuards(SessionTokenGuard, OrgMembershipGuard)
@Controller('clinical-cases/organization/:organizationId')
export class ClinicalCasesController {
  constructor(private readonly service: ClinicalCasesService) {}

  /** GET .../event/:eventId/available — casos habilitados + mi último intento */
  @Get('event/:eventId/available')
  available(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.service.available(req.auth.uid, organizationId, eventId);
  }

  /**
   * POST .../cases/:caseId/sessions  { part?: "acute" | "followup" }
   * Retoma el intento en curso o crea uno (el seguimiento requiere haber
   * terminado la parte aguda).
   */
  @Post('cases/:caseId/sessions')
  start(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('caseId') caseId: string,
    @Body() body: { part?: string },
  ) {
    return this.service.start(
      req.auth.uid,
      organizationId,
      caseId,
      body?.part === 'followup' ? 'followup' : 'acute',
    );
  }

  @Get('sessions/:sessionId')
  get(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.service.getMine(req.auth.uid, organizationId, sessionId);
  }

  /** POST .../sessions/:sessionId/messages  { text?, selected? } */
  @Post('sessions/:sessionId/messages')
  message(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: { text?: string; selected?: string[] },
  ) {
    return this.service.message(
      req.auth.uid,
      organizationId,
      sessionId,
      String(body?.text ?? ''),
      Array.isArray(body?.selected) ? body.selected.map(String) : [],
    );
  }
}
