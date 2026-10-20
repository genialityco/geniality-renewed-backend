import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SessionTokenGuard } from 'src/auth/session-token.guard';
import { OrgAdminGuard } from 'src/auth/org-admin.guard';
import { EngagementReportService } from './engagement-report.service';
import {
  EngagementKind,
  EngagementStatus,
} from './schemas/engagement-message.schema';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: EngagementKind[] = [
  'inactivity_reminder',
  'weekly_report',
  'course_ranking',
  'practice_review',
  'practice_invite',
];
const STATUSES: EngagementStatus[] = [
  'pending',
  'sent',
  'fallback_email',
  'failed',
  'holdout',
  'capped',
];

/**
 * Resultados de los mensajes que inicia la plataforma. Solo para
 * administradores de la organización de la ruta.
 */
@UseGuards(SessionTokenGuard, OrgAdminGuard)
@Controller('engagement/organization/:organizationId')
export class EngagementController {
  constructor(private readonly reportService: EngagementReportService) {}

  /**
   * GET /engagement/organization/:organizationId/summary
   *   ?from=YYYY-MM-DD&to=YYYY-MM-DD&kind=&windowHours=72
   */
  @Get('summary')
  async summary(
    @Param('organizationId') organizationId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('kind') kind?: string,
    @Query('windowHours') windowHours?: string,
  ) {
    return this.reportService.summary(
      organizationId,
      this.parseFilter({ from, to, kind, windowHours }),
    );
  }

  /**
   * GET /engagement/organization/:organizationId/messages
   *   ?from=&to=&kind=&status=&windowHours=72&limit=200
   */
  @Get('messages')
  async messages(
    @Param('organizationId') organizationId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('windowHours') windowHours?: string,
    @Query('limit') limit?: string,
  ) {
    if (status && !STATUSES.includes(status as EngagementStatus)) {
      throw new BadRequestException(`"status" admite: ${STATUSES.join(', ')}`);
    }
    return this.reportService.messages(organizationId, {
      ...this.parseFilter({ from, to, kind, windowHours }),
      status: (status as EngagementStatus) || undefined,
      limit: limit ? Number(limit) || undefined : undefined,
    });
  }

  private parseFilter(q: {
    from?: string;
    to?: string;
    kind?: string;
    windowHours?: string;
  }) {
    if ((q.from && !DATE_RE.test(q.from)) || (q.to && !DATE_RE.test(q.to))) {
      throw new BadRequestException(
        '"from"/"to" deben tener formato YYYY-MM-DD',
      );
    }
    if (q.kind && !KINDS.includes(q.kind as EngagementKind)) {
      throw new BadRequestException(`"kind" admite: ${KINDS.join(', ')}`);
    }
    return {
      from: q.from || undefined,
      to: q.to || undefined,
      kind: (q.kind as EngagementKind) || undefined,
      windowHours: q.windowHours ? Number(q.windowHours) : undefined,
    };
  }
}
