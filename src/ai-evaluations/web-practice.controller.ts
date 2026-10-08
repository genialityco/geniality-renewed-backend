import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionTokenGuard } from 'src/auth/session-token.guard';
import { OrgMembershipGuard } from 'src/auth/org-membership.guard';
import {
  WebPracticeAnswerBody,
  WebPracticeService,
} from './web-practice.service';

/**
 * "Evaluar mis conocimientos" por actividad, dentro de la plataforma. Las
 * respuestas correctas solo se devuelven después de responder cada pregunta.
 */
@UseGuards(SessionTokenGuard, OrgMembershipGuard)
@Controller(
  'ai-evaluations/organization/:organizationId/activities/:activityId/practice',
)
export class WebPracticeController {
  constructor(private readonly service: WebPracticeService) {}

  /** GET .../practice/availability → { available, active_session_id } */
  @Get('availability')
  async availability(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('activityId') activityId: string,
  ) {
    return this.service.availability(req.auth.uid, organizationId, activityId);
  }

  /** POST .../practice → retoma la práctica en curso o crea una nueva */
  @Post()
  async start(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('activityId') activityId: string,
  ) {
    return this.service.start(req.auth.uid, organizationId, activityId);
  }

  /** POST .../practice/:sessionId/answer  { index, selected?, text?, skipped? } */
  @Post(':sessionId/answer')
  async answer(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('activityId') activityId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: WebPracticeAnswerBody,
  ) {
    return this.service.answer(
      req.auth.uid,
      organizationId,
      activityId,
      sessionId,
      body || {},
    );
  }
}
