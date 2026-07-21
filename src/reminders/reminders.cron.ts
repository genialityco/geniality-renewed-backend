import { Injectable, Logger } from '@nestjs/common';
// Cron y CronExpression se reimportan de '@nestjs/schedule' al reactivar los jobs de abajo
import { RemindersService } from './reminders.service';
import { WeeklyReportService } from './weekly-report.service';

@Injectable()
export class RemindersCron {
  private readonly logger = new Logger(RemindersCron.name);

  constructor(
    private readonly remindersService: RemindersService,
    private readonly weeklyReportService: WeeklyReportService,
  ) {}

  // Desactivado temporalmente: recordatorios de inactividad pausados
  // @Cron(CronExpression.EVERY_DAY_AT_9AM)
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

  // Desactivado temporalmente: reporte semanal pausado
  // Lunes 10am, una hora después del job de inactividad para no solaparse
  // @Cron('0 10 * * 1')
  async runWeeklyReport() {
    this.logger.log('Iniciando job de reporte semanal de progreso');
    try {
      await this.weeklyReportService.sendWeeklyReports();
    } catch (error) {
      this.logger.error('Fallo el job de reporte semanal', error as any);
    }
  }
}
