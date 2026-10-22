import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { GenOnProgram } from './schemas/genon-program.schema';
import { GenOnTriggersService } from './genon-triggers.service';

/**
 * Cada 15 minutos corre los programas encendidos (simulación o activo): la
 * segmentación y los disparadores diarios una vez al día, los disparadores
 * por actividad completada, y el despacho de lo que ya toca en su franja.
 * Solo con GENON_CRON_ENABLED=true, para que un backend local conectado a la
 * base de producción no envíe mensajes. Asume una sola instancia.
 */
@Injectable()
export class GenOnCron {
  private readonly logger = new Logger(GenOnCron.name);
  private running = false;

  constructor(
    @InjectModel(GenOnProgram.name)
    private readonly programModel: Model<GenOnProgram>,
    private readonly runner: GenOnTriggersService,
  ) {}

  @Cron('0 */15 * * * *')
  async tick() {
    if (process.env.GENON_CRON_ENABLED !== 'true') return;
    if (this.running) return;
    this.running = true;
    try {
      const programs = await this.programModel
        .find({ mode: { $in: ['dry_run', 'live'] } })
        .exec();
      for (const program of programs) {
        try {
          const { outcomes } = await this.runner.run(program, new Date());
          const sent = outcomes.filter((o) =>
            ['sent', 'fallback_email', 'planned'].includes(o.result),
          ).length;
          if (sent) {
            this.logger.log(
              `Gen.ON "${program.name}" (${program.mode}): ${sent} toques`,
            );
          }
        } catch (error) {
          this.logger.error(
            `Gen.ON "${program.name}" falló: ${(error as Error).message}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
