import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { GenOnProgram } from './schemas/genon-program.schema';
import { GenOnEnrollment } from './schemas/genon-enrollment.schema';
import { GenOnTriggersService } from './genon-triggers.service';

/**
 * Cada 15 minutos corre los programas encendidos (simulación o activo): la
 * segmentación y los disparadores diarios una vez al día, los disparadores
 * por actividad completada, y el despacho de lo que ya toca en su franja.
 * Solo con GENON_CRON_ENABLED=true, para que un backend local conectado a la
 * base de producción no envíe mensajes. Asume una sola instancia.
 */
@Injectable()
export class GenOnCron implements OnModuleInit {
  private readonly logger = new Logger(GenOnCron.name);
  private running = false;

  constructor(
    @InjectModel(GenOnProgram.name)
    private readonly programModel: Model<GenOnProgram>,
    @InjectModel(GenOnEnrollment.name)
    private readonly enrollmentModel: Model<GenOnEnrollment>,
    private readonly runner: GenOnTriggersService,
  ) {}

  onModuleInit() {
    this.logger.log(
      process.env.GENON_CRON_ENABLED === 'true'
        ? 'Gen.ON: cron encendido (cada 15 minutos)'
        : 'Gen.ON: cron apagado (falta GENON_CRON_ENABLED=true)',
    );
  }

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
          const { segmentation, outcomes } = await this.runner.run(program, new Date());
          const byResult: Record<string, number> = {};
          const reasons: Record<string, number> = {};
          for (const o of outcomes) {
            byResult[o.result] = (byResult[o.result] || 0) + 1;
            if (o.reason) reasons[o.reason] = (reasons[o.reason] || 0) + 1;
          }
          this.logger.log(
            `Gen.ON "${program.name}" (${program.mode}): ` +
              (segmentation ? `segmentó ${JSON.stringify(segmentation.counts)} · ` : '') +
              `resultados ${JSON.stringify(byResult)} · ` +
              (Object.keys(reasons).length ? `motivos ${JSON.stringify(reasons)} · ` : '') +
              (await this.nextSend(program)),
          );
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

  /** Próximo toque de secuencia programado (para ver en el log que hay algo en camino). */
  private async nextSend(program: GenOnProgram): Promise<string> {
    const next = await this.enrollmentModel
      .findOne({
        program_id: String(program._id),
        test: false,
        exited: false,
        paused: false,
        holdout: false,
        next_step_at: { $ne: null },
      })
      .sort({ next_step_at: 1 })
      .select('next_step_at next_step_key')
      .lean()
      .exec();
    if (!next?.next_step_at) return 'sin toques de secuencia programados';
    const at = new Date(next.next_step_at).toLocaleString('es-CO', {
      timeZone: program.timezone,
    });
    return `próximo toque ${next.next_step_key} el ${at}`;
  }
}
