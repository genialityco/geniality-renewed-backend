import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Put,
  Patch,
  Delete,
  Query,
  NotFoundException,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { SessionTokenGuard } from '../auth/session-token.guard';
import { ActivitiesService } from './activities.service';
import { Activity } from './schemas/activity.schema';
import { TranscriptSegmentsService } from 'src/transcript-segments/transcript-segments.service';
import { TranscriptionPollingService } from './transcription-polling.service';
import { VimeoResolverService } from './vimeo-resolver.service';
import { BunnyResolverService } from './bunny-resolver.service';
import { AssemblyAiService } from './assemblyai.service';
import {
  MigrationTextTranscriptionService,
  MigrationResult,
} from './migration-text-transcription.service';
import { DocumentsService } from '../documents/documents.service';

@Controller('activities')
export class ActivitiesController {
  constructor(
    private readonly activitiesService: ActivitiesService,
    private readonly transcriptSegmentsService: TranscriptSegmentsService,
    private readonly transcriptionPollingService: TranscriptionPollingService,
    private readonly vimeoResolverService: VimeoResolverService,
    private readonly bunnyResolverService: BunnyResolverService,
    private readonly assemblyAiService: AssemblyAiService,
    private readonly documentsService: DocumentsService,
    private readonly migrationService: MigrationTextTranscriptionService,
  ) {}

  // Crear una actividad
  @Post()
  async create(@Body() activityData: Partial<Activity>): Promise<Activity> {
    return this.activitiesService.create(activityData);
  }

  // Listar todas o filtrar por organización
  @Get('by-organization')
  async findByOrganization(
    @Query('organizationId') organizationId?: string,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
  ) {
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    return this.activitiesService.findByOrganization(
      organizationId,
      pageNum,
      limitNum,
    );
  }

  // Obtener una actividad por ID
  @Get(':id')
  async findOne(@Param('id') id: string): Promise<Activity> {
    return this.activitiesService.findOne(id);
  }

  // Actualizar (PUT o PATCH). Aquí demuestro ambas opciones, elige la que uses en tu frontend.
  @Put(':id')
  async updatePut(
    @Param('id') id: string,
    @Body() activityData: Partial<Activity>,
  ): Promise<Activity> {
    return this.activitiesService.update(id, activityData);
  }

  @Patch(':id')
  async updatePatch(
    @Param('id') id: string,
    @Body() activityData: Partial<Activity>,
  ): Promise<Activity> {
    return this.activitiesService.update(id, activityData);
  }

  // Eliminar actividad
  @Delete(':id')
  async delete(@Param('id') id: string): Promise<Activity> {
    return this.activitiesService.delete(id);
  }

  // Listar actividades de un evento
  @Get('event/:event_id')
  async findByEventId(
    @Param('event_id') event_id: string,
  ): Promise<Activity[]> {
    return this.activitiesService.findByEventId(event_id);
  }

  // Actualizar video_progress
  @Put(':id/video-progress')
  async updateVideoProgress(
    @Param('id') id: string,
    @Body('progress') progress: number,
  ): Promise<Activity> {
    return this.activitiesService.updateVideoProgress(id, progress);
  }

  // Generar transcripción - enqueua en AssemblyAI y comienza polling asincrónico
  @UseGuards(SessionTokenGuard)
  @Post('generate-transcript/:activity_id')
  async generateTranscript(@Param('activity_id') activity_id: string) {
    const activity = await this.activitiesService.findOne(activity_id);
    if (!activity) {
      throw new NotFoundException('Activity not found');
    }

    const primaryVideo = this.getPrimaryVideo(activity);
    if (!primaryVideo) {
      throw new BadRequestException('This activity has no video');
    }

    // Resolver el video a una URL pública reproducible, según su proveedor
    let audioUrl: string;
    if (primaryVideo.provider === 'vimeo') {
      console.log(
        `🔍 Resolviendo URL de video (Vimeo): ${primaryVideo.video_id}`,
      );
      audioUrl = await this.vimeoResolverService.resolveDirectUrlViaApi(
        primaryVideo.video_id,
        activity.organization_id?.toString(),
      );
    } else if (primaryVideo.provider === 'bunny') {
      console.log(
        `🔍 Resolviendo URL de video (Bunny): ${primaryVideo.video_id}`,
      );
      audioUrl = await this.bunnyResolverService.resolveUrl(
        primaryVideo.video_id,
        primaryVideo.meta?.library_id,
      );
    } else {
      throw new BadRequestException(
        `Video provider "${primaryVideo.provider}" is not supported for transcript generation`,
      );
    }
    console.log(`✅ URL resuelta: ${audioUrl}`);

    const transcriptId =
      await this.assemblyAiService.submitTranscription(audioUrl);

    // Guardar el id del transcript en la actividad
    await this.activitiesService.update(activity_id, {
      transcription_job_id: transcriptId,
    });

    console.log(
      `✅ Transcript ${transcriptId} enqueued y guardado en BD para activity ${activity_id}`,
    );

    // Iniciar polling asincrónico (NO await - se ejecuta en background)
    this.transcriptionPollingService.startPolling(transcriptId, activity_id);

    return {
      message: 'Transcription job enqueued successfully',
      jobId: transcriptId,
      status: 'queued',
    };
  }

  @UseGuards(SessionTokenGuard)
  @Get('transcription-status/:job_id')
  async getJobStatus(@Param('job_id') job_id: string) {
    return this.assemblyAiService.getTranscriptionResult(job_id);
  }

  // Validar y recuperar transcripts en "done"
  @UseGuards(SessionTokenGuard)
  @Post('validate-transcripts')
  async validateTranscripts() {
    console.log('🔍 Iniciando validación de transcripts pendientes...');

    // Buscar actividades con job_id pero sin transcript_available = true
    const activitiesWithJobs =
      await this.activitiesService.findActivitiesWithPendingJobs();
    console.log(
      `📊 Se encontraron ${activitiesWithJobs.length} actividades con jobs pendientes`,
    );

    const results = {
      checked: 0,
      updated: 0,
      errors: [] as string[],
      details: [] as any[],
    };

    for (const activity of activitiesWithJobs) {
      const jobId = activity.transcription_job_id;
      results.checked++;

      try {
        console.log(`✓ Verificando job ${jobId} para activity ${activity._id}`);

        // Consultar estado del transcript en AssemblyAI
        const data = await this.assemblyAiService.getTranscriptionResult(jobId);

        if (data.status === 'completed') {
          const sentences = await this.assemblyAiService.getSentences(jobId);
          console.log(
            `✅ Job ${jobId} está completo con ${sentences.length} sentences`,
          );

          // Guardar segmentos (AssemblyAI da start/end en ms; los segmentos se guardan en segundos)
          const segments = sentences.map((s) => ({
            startTime: s.start / 1000,
            endTime: s.end / 1000,
            text: s.text,
          }));
          await this.transcriptSegmentsService.createSegments(
            String(activity._id),
            segments,
          );

          // Marcar como disponible y guardar el texto completo
          await this.activitiesService.update(String(activity._id), {
            transcript_available: true,
            textTranscription: data.text,
          });

          results.updated++;
          results.details.push({
            activityId: activity._id,
            jobId,
            status: 'done',
            segmentCount: segments.length,
            message: 'Transcript marcado como disponible',
          });

          console.log(
            `📝 Activity ${activity._id} marcada como transcript_available`,
          );
        } else if (data.status === 'processing' || data.status === 'queued') {
          console.log(`⏳ Job ${jobId} aún está procesando`);
          results.details.push({
            activityId: activity._id,
            jobId,
            status: 'processing',
            message: 'Job aún en procesamiento',
          });
        } else if (data.status === 'error') {
          console.error(`❌ Job ${jobId} tiene error: ${data.error}`);
          results.errors.push(`Job ${jobId}: ${data.error}`);
          results.details.push({
            activityId: activity._id,
            jobId,
            status: 'error',
            error: data.error,
            message: 'Job con error',
          });
        } else {
          results.details.push({
            activityId: activity._id,
            jobId,
            status: data.status,
            message: `Estado desconocido: ${data.status}`,
          });
        }
      } catch (error: any) {
        const errorMsg = `Activity ${activity._id} (Job ${jobId}): ${error.response?.data?.error || error.message}`;
        console.error(`❌ Error validando: ${errorMsg}`);
        results.errors.push(errorMsg);
        results.details.push({
          activityId: activity._id,
          jobId,
          error: error.message,
          message: 'Error al consultar estado',
        });
      }
    }

    console.log(`📊 Validación completada:`, {
      checked: results.checked,
      updated: results.updated,
      errors: results.errors.length,
    });

    return {
      message: `Validación completada. Se actualizaron ${results.updated} de ${results.checked} transcripts`,
      ...results,
    };
  }

  // Validar y actualizar un transcript específico si está en "done"
  @UseGuards(SessionTokenGuard)
  @Post('validate-transcript/:activity_id')
  async validateSingleTranscript(@Param('activity_id') activity_id: string) {
    console.log(`🔍 Validando transcript para activity ${activity_id}`);

    const activity = await this.activitiesService.findOne(activity_id);
    if (!activity) {
      throw new NotFoundException('Activity not found');
    }

    if (!activity.transcription_job_id) {
      throw new BadRequestException(
        'Activity does not have a transcription job',
      );
    }

    const jobId = activity.transcription_job_id;

    try {
      // Consultar estado del transcript en AssemblyAI
      console.log(`📥 Consultando transcript ${jobId} en AssemblyAI`);
      const data = await this.assemblyAiService.getTranscriptionResult(jobId);

      console.log(`📊 Status del job: ${data.status}`);

      if (data.status === 'completed') {
        const sentences = await this.assemblyAiService.getSentences(jobId);
        console.log(
          `✅ Job ${jobId} está completo con ${sentences.length} sentences`,
        );

        // Guardar segmentos (AssemblyAI da start/end en ms; los segmentos se guardan en segundos)
        const segments = sentences.map((s) => ({
          startTime: s.start / 1000,
          endTime: s.end / 1000,
          text: s.text,
        }));
        await this.transcriptSegmentsService.createSegments(
          activity_id,
          segments,
        );

        // Marcar como disponible y guardar el texto completo
        await this.activitiesService.update(activity_id, {
          transcript_available: true,
          textTranscription: data.text,
        });

        const updatedActivity =
          await this.activitiesService.findOne(activity_id);

        console.log(
          `✏️ Activity ${activity_id} marcada como transcript_available`,
        );

        return {
          message: 'Transcription validated and saved successfully',
          activity: updatedActivity,
          status: 'done',
          segmentCount: segments.length,
        };
      } else if (data.status === 'processing' || data.status === 'queued') {
        console.log(`⏳ Job ${jobId} aún está procesando`);
        return {
          message: 'Transcription is still processing',
          status: 'processing',
          jobId,
        };
      } else if (data.status === 'error') {
        console.error(`❌ Job ${jobId} tiene error: ${data.error}`);
        throw new BadRequestException(`Transcription job error: ${data.error}`);
      } else {
        return {
          message: `Unknown status: ${data.status}`,
          status: data.status,
          jobId,
        };
      }
    } catch (error: any) {
      const errorMsg =
        error.response?.data?.error || error.message || 'Unknown error';
      console.error(`❌ Error validando transcript: ${errorMsg}`);
      throw new BadRequestException(
        `Failed to validate transcript: ${errorMsg}`,
      );
    }
  }

  // Selecciona el video "principal" de una actividad: el activo con mayor
  // prioridad (número más bajo); si ninguno está activo, el de mayor
  // prioridad entre todos.
  private getPrimaryVideo(activity: Activity) {
    const videos = activity.videos || [];
    if (videos.length === 0) {
      return null;
    }

    const active = videos.filter((v) => v.status === 'active');
    const pool = active.length > 0 ? active : videos;

    return [...pool].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))[0];
  }

  // Función para normalizar la URL de Vimeo
  private normalizeVimeoUrl(url: string): string {
    // Extrae el ID del video de diferentes formatos de URL
    const regex =
      /vimeo\.com\/(?:video\/)?(\d+)|player\.vimeo\.com\/video\/(\d+)/;
    const match = url.match(regex);
    const videoId = match?.[1] || match?.[2];
    if (videoId) {
      return `https://vimeo.com/video/${videoId}`;
    }
    // Si no es una URL válida, retorna la original (o podrías lanzar error)
    return url;
  }

  // Obtener documentos asociados a una actividad
  @Get(':activityId/documents')
  async getActivityDocuments(@Param('activityId') activityId: string) {
    const activity = await this.activitiesService.findOne(activityId);
    if (!activity) {
      throw new NotFoundException('Activity not found');
    }
    return this.documentsService.getDocumentsByOrganization(
      activity.organization_id.toString(),
      {
        activityId,
      },
    );
  }

  // ============================================
  // ENDPOINTS DE MIGRACIÓN DE textTranscription
  // ============================================

  /**
   * Ejecuta la migración completa
   * POST /activities/migration/run
   */
  @UseGuards(SessionTokenGuard)
  @Post('migration/run')
  async runMigration(): Promise<MigrationResult> {
    console.log('🚀 Usuario ejecutando migración de textTranscription');
    return this.migrationService.migrateAllTextTranscriptions();
  }

  /**
   * Obtiene estadísticas de la migración sin ejecutarla
   * GET /activities/migration/statistics
   */
  @UseGuards(SessionTokenGuard)
  @Get('migration/statistics')
  async getMigrationStatistics() {
    console.log('📊 Usuario solicitando estadísticas de migración');
    return this.migrationService.getStatistics();
  }

  /**
   * Migra una actividad específica
   * POST /activities/migration/:activityId
   */
  @UseGuards(SessionTokenGuard)
  @Post('migration/:activityId')
  async migrateSpecificActivity(@Param('activityId') activityId: string) {
    console.log(`🔄 Usuario migrando actividad específica: ${activityId}`);
    return this.migrationService.migrateActivityById(activityId);
  }
}
