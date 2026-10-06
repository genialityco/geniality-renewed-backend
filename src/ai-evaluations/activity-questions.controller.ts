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
import { OrgMembershipGuard } from 'src/auth/org-membership.guard';
import {
  ActivityQuestionsService,
  GenerateQuestionsBody,
  QuestionInput,
} from './activity-questions.service';

/**
 * Banco de preguntas por actividad (admin): generación con IA a partir del
 * curso y el transcript del video, y edición manual.
 */
@UseGuards(SessionTokenGuard, OrgMembershipGuard)
@Controller('ai-evaluations/organization/:organizationId')
export class ActivityQuestionsController {
  constructor(private readonly service: ActivityQuestionsService) {}

  /** GET .../event/:eventId/activity-questions/counts → { [activityId]: { total, enabled } } */
  @Get('event/:eventId/activity-questions/counts')
  async counts(
    @Param('organizationId') organizationId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.service.countsByEvent(organizationId, eventId);
  }

  /** GET .../activities/:activityId/questions */
  @Get('activities/:activityId/questions')
  async list(
    @Param('organizationId') organizationId: string,
    @Param('activityId') activityId: string,
  ) {
    return this.service.list(organizationId, activityId);
  }

  /**
   * POST .../activities/:activityId/questions/generate
   * Body: { num_questions?, difficulty?, instructions?, mode?: 'replace' | 'append' }
   * Síncrono: con un video de 2 h tarda ~20-60 s.
   */
  @Post('activities/:activityId/questions/generate')
  async generate(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('activityId') activityId: string,
    @Body() body: GenerateQuestionsBody,
  ) {
    return this.service.generate(
      organizationId,
      activityId,
      body || {},
      req.auth.uid,
    );
  }

  /** POST .../activities/:activityId/questions — pregunta manual */
  @Post('activities/:activityId/questions')
  async create(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('activityId') activityId: string,
    @Body() body: QuestionInput,
  ) {
    return this.service.create(
      organizationId,
      activityId,
      body || {},
      req.auth.uid,
    );
  }

  /** PUT .../activities/:activityId/questions/:questionId */
  @Put('activities/:activityId/questions/:questionId')
  async update(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('activityId') activityId: string,
    @Param('questionId') questionId: string,
    @Body() body: QuestionInput,
  ) {
    return this.service.update(
      organizationId,
      activityId,
      questionId,
      body || {},
      req.auth.uid,
    );
  }

  /** DELETE .../activities/:activityId/questions/:questionId */
  @Delete('activities/:activityId/questions/:questionId')
  async remove(
    @Param('organizationId') organizationId: string,
    @Param('activityId') activityId: string,
    @Param('questionId') questionId: string,
  ) {
    return this.service.remove(organizationId, activityId, questionId);
  }

  /** DELETE .../activities/:activityId/questions — borra todas */
  @Delete('activities/:activityId/questions')
  async removeAll(
    @Param('organizationId') organizationId: string,
    @Param('activityId') activityId: string,
  ) {
    return this.service.removeAll(organizationId, activityId);
  }
}
