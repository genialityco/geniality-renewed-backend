import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RemindersService } from './reminders.service';
import { WeeklyReportService } from './weekly-report.service';
import { CourseRankingService } from './course-ranking.service';

const TIMEZONE = 'America/Bogota';

/**
 * Jobs de recordatorios. Solo corren con REMINDERS_CRON_ENABLED=true, para
 * que un backend local conectado a la base de producción no envíe mensajes
 * reales. La bitácora de envíos (EngagementLogService) evita duplicados si
 * además se disparan a mano desde RemindersController.
 */
@Injectable()
export class RemindersCron {
  private readonly logger = new Logger(RemindersCron.name);
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly remindersService: RemindersService,
    private readonly weeklyReportService: WeeklyReportService,
    private readonly courseRankingService: CourseRankingService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_9AM, { timeZone: TIMEZONE })
  async run() {
    await this.exclusive('recordatorios de inactividad (3 días)', () =>
      this.remindersService.sendInactivityReminders(),
    );
  }

  // Lunes 10am, una hora después del job de inactividad para no solaparse
  @Cron('0 10 * * 1', { timeZone: TIMEZONE })
  async runWeeklyReport() {
    await this.exclusive('reporte semanal de progreso', () =>
      this.weeklyReportService.sendWeeklyReports(),
    );
  }

  // Martes 10am, un día después del reporte semanal para no solaparse
  @Cron('0 10 * * 2', { timeZone: TIMEZONE })
  async runCourseRanking() {
    await this.exclusive('comparación de curso entre compañeros', () =>
      this.courseRankingService.sendCourseRankingMessages(),
    );
  }

  /**
   * Un job a la vez: si uno se demora, el siguiente espera en vez de
   * encimarse (y en vez de perderse, que dejaría la semana sin reporte).
   */
  private exclusive(name: string, job: () => Promise<unknown>) {
    if (process.env.REMINDERS_CRON_ENABLED !== 'true') return;
    this.queue = this.queue.then(async () => {
      this.logger.log(`Iniciando job de ${name}`);
      try {
        await job();
      } catch (error) {
        this.logger.error(`Falló el job de ${name}`, error as any);
      }
    });
    return this.queue;
  }
}
