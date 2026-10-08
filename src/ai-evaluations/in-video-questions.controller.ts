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
  InVideoAnswerBody,
  InVideoQuestionsService,
} from './in-video-questions.service';

/**
 * Preguntas dentro del video para el estudiante: nunca incluyen la respuesta
 * correcta, se califican en el servidor.
 */
@UseGuards(SessionTokenGuard, OrgMembershipGuard)
@Controller(
  'ai-evaluations/organization/:organizationId/activities/:activityId/in-video-questions',
)
export class InVideoQuestionsController {
  constructor(private readonly service: InVideoQuestionsService) {}

  /** GET → { enabled, questions: [{ id, type, question, options, trigger_at, start_time }] } */
  @Get()
  async list(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('activityId') activityId: string,
  ) {
    return this.service.forActivity(req.auth.uid, organizationId, activityId);
  }

  /** POST /:questionId/answer  { selected?: number[], skipped?: boolean } */
  @Post(':questionId/answer')
  async answer(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('activityId') activityId: string,
    @Param('questionId') questionId: string,
    @Body() body: InVideoAnswerBody,
  ) {
    return this.service.answer(
      req.auth.uid,
      organizationId,
      activityId,
      questionId,
      body || {},
    );
  }
}
