import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RemindersService } from './reminders.service';

@Injectable()
export class RemindersCron {
  private readonly logger = new Logger(RemindersCron.name);

  constructor(private readonly remindersService: RemindersService) {}

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async run() {
    this.logger.log('Iniciando job de recordatorios de inactividad (3 días)');
    try {
      await this.remindersService.sendInactivityReminders();
    } catch (error) {
      this.logger.error(
        'Fallo el job de recordatorios de inactividad',
        error as any,
      );
    }
  }
}
