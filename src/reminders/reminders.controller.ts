import { Controller, Post, Query, UseGuards } from '@nestjs/common';
import { SessionTokenGuard } from '../auth/session-token.guard';
import { RemindersService } from './reminders.service';

// Endpoint para disparar el job manualmente (el cron llama al servicio
// directamente, sin pasar por aquí).
@Controller('reminders')
export class RemindersController {
  constructor(private readonly remindersService: RemindersService) {}

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
}
