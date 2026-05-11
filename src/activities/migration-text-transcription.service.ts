import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Activity } from './schemas/activity.schema';
import { TranscriptSegmentsService } from 'src/transcript-segments/transcript-segments.service';

export interface MigrationResult {
  totalActivities: number;
  successCount: number;
  errorCount: number;
  errors: { activityId: string; error: string }[];
}

@Injectable()
export class MigrationTextTranscriptionService {
  private readonly logger = new Logger(MigrationTextTranscriptionService.name);

  constructor(
    @InjectModel(Activity.name)
    private readonly activityModel: Model<Activity>,
    private readonly transcriptSegmentsService: TranscriptSegmentsService,
  ) {}

  /**
   * Migra todas las actividades que tienen transcript_available = true
   * pero textTranscription = null o undefined
   */
  async migrateAllTextTranscriptions(): Promise<MigrationResult> {
    this.logger.log('🔄 Iniciando migración de textTranscription...');

    const result: MigrationResult = {
      totalActivities: 0,
      successCount: 0,
      errorCount: 0,
      errors: [],
    };

    try {
      // Encontrar todas las actividades que necesitan migración
      const activitiesToMigrate = await this.activityModel.find({
        transcript_available: true,
        $or: [{ textTranscription: null }, { textTranscription: undefined }],
      });

      result.totalActivities = activitiesToMigrate.length;
      this.logger.log(
        `📋 Encontradas ${result.totalActivities} actividades para migrar`,
      );

      // Procesar cada actividad
      for (const activity of activitiesToMigrate) {
        try {
          this.logger.debug(`⏳ Procesando actividad: ${activity._id}`);

          // Obtener segmentos
          const segments = await this.transcriptSegmentsService.getSegmentsByActivity(
            activity._id.toString(),
          );

          if (!segments || segments.length === 0) {
            this.logger.warn(
              `⚠️ La actividad ${activity._id} no tiene segmentos`,
            );
            result.errorCount++;
            result.errors.push({
              activityId: activity._id.toString(),
              error: 'No segments found',
            });
            continue;
          }

          // Combinar segmentos ordenados por startTime
          const combinedText = segments
            .sort((a, b) => a.startTime - b.startTime)
            .map((segment) => segment.text)
            .join(' ');

          // Actualizar la actividad
          await this.activityModel.findByIdAndUpdate(
            activity._id,
            { textTranscription: combinedText },
            { new: true },
          );

          result.successCount++;
          this.logger.log(
            `✅ Migrada actividad ${activity._id} (${combinedText.length} caracteres)`,
          );
        } catch (error) {
          result.errorCount++;
          const errorMessage = error instanceof Error ? error.message : String(error);
          result.errors.push({
            activityId: activity._id.toString(),
            error: errorMessage,
          });
          this.logger.error(
            `❌ Error migrando actividad ${activity._id}: ${errorMessage}`,
          );
        }
      }

      this.logger.log(`
✅ MIGRACIÓN COMPLETADA
────────────────────────
Total de actividades: ${result.totalActivities}
Exitosas: ${result.successCount}
Errores: ${result.errorCount}
────────────────────────
      `);

      return result;
    } catch (error) {
      this.logger.error('❌ Error fatal durante la migración:', error);
      throw error;
    }
  }

  /**
   * Migra una actividad específica (útil para depuración)
   */
  async migrateActivityById(activityId: string): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      this.logger.log(`🔄 Migrando actividad: ${activityId}`);

      const activity = await this.activityModel.findById(activityId);
      if (!activity) {
        throw new Error('Activity not found');
      }

      if (!activity.transcript_available) {
        throw new Error('Activity does not have transcript_available = true');
      }

      const segments = await this.transcriptSegmentsService.getSegmentsByActivity(
        activityId,
      );

      if (!segments || segments.length === 0) {
        throw new Error('No segments found for this activity');
      }

      const combinedText = segments
        .sort((a, b) => a.startTime - b.startTime)
        .map((segment) => segment.text)
        .join(' ');

      await this.activityModel.findByIdAndUpdate(
        activityId,
        { textTranscription: combinedText },
        { new: true },
      );

      this.logger.log(
        `✅ Actividad ${activityId} migrada (${combinedText.length} caracteres)`,
      );
      return {
        success: true,
        message: `Successfully migrated activity ${activityId}`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ Error migrando actividad ${activityId}: ${errorMessage}`);
      return {
        success: false,
        message: errorMessage,
      };
    }
  }

  /**
   * Obtiene estadísticas de la migración (sin ejecutarla)
   */
  async getStatistics(): Promise<{
    needMigration: number;
    alreadyMigrated: number;
    noTranscript: number;
  }> {
    const needMigration = await this.activityModel.countDocuments({
      transcript_available: true,
      $or: [{ textTranscription: null }, { textTranscription: undefined }],
    });

    const alreadyMigrated = await this.activityModel.countDocuments({
      transcript_available: true,
      textTranscription: { $ne: null, $exists: true },
    });

    const noTranscript = await this.activityModel.countDocuments({
      transcript_available: false,
    });

    return {
      needMigration,
      alreadyMigrated,
      noTranscript,
    };
  }
}
