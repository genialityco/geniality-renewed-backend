import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CourseSnapshotsService } from './course-snapshots.service';

/**
 * Snapshot diario de indicadores de todos los cursos con inscritos, al final
 * del día en Colombia. Solo corre con COURSE_SNAPSHOTS_CRON_ENABLED=true, para
 * que un backend local conectado a la base de producción no lo duplique.
 */
@Injectable()
export class CourseSnapshotsCron {
  private readonly logger = new Logger(CourseSnapshotsCron.name);
  private running = false;

  constructor(private readonly snapshotsService: CourseSnapshotsService) {}

  @Cron('0 50 23 * * *', { timeZone: 'America/Bogota' })
  async run() {
    if (process.env.COURSE_SNAPSHOTS_CRON_ENABLED !== 'true') return;
    if (this.running) return;
    this.running = true;
    try {
      await this.snapshotsService.runDaily();
    } catch (error) {
      this.logger.error(`Snapshot diario: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
