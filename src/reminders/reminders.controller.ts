import { Controller, Post, Query, UseGuards } from '@nestjs/common';
import { SessionTokenGuard } from '../auth/session-token.guard';
import { RemindersService } from './reminders.service';
import { WeeklyReportService } from './weekly-report.service';

// Endpoints para disparar los jobs manualmente (el cron llama a los
// servicios directamente, sin pasar por aquí).
@Controller('reminders')
export class RemindersController {
  constructor(
    private readonly remindersService: RemindersService,
    private readonly weeklyReportService: WeeklyReportService,
  ) {}

  @UseGuards(SessionTokenGuard)
  @Post('inactivity/run')
  async runInactivityCheck(
    @Query('userId') userId?: string,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.remindersService.sendInactivityReminders({
      userId,
      organizationId,
    });
  }

  @UseGuards(SessionTokenGuard)
  @Post('weekly-report/run')
  async runWeeklyReport(
    @Query('userId') userId?: string,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.weeklyReportService.sendWeeklyReports({
      userId,
      organizationId,
    });
  }
}
