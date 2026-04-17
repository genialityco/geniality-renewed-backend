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
} from '@nestjs/common';
import { ActivitiesService } from './activities.service';
import { Activity } from './schemas/activity.schema';
import { TranscriptSegmentsService } from 'src/transcript-segments/transcript-segments.service';
import { TranscriptionPollingService } from './transcription-polling.service';
import { VimeoResolverService } from './vimeo-resolver.service';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';

@Controller('activities')
export class ActivitiesController {
  constructor(
    private readonly activitiesService: ActivitiesService,
    private readonly transcriptSegmentsService: TranscriptSegmentsService,
    private readonly httpService: HttpService,
    private readonly transcriptionPollingService: TranscriptionPollingService,
    private readonly vimeoResolverService: VimeoResolverService,
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

  // Generar transcripción - enqueua en el servicio externo y comienza polling asincrónico
  @Post('generate-transcript/:activity_id')
  async generateTranscript(
    @Param('activity_id') activity_id: string,
    @Body('use_gpu') use_gpu: boolean = true,
    @Body('generate_embeddings') generate_embeddings: boolean = true,
  ) {
    const activity = await this.activitiesService.findOne(activity_id);
    if (!activity) {
      throw new NotFoundException('Activity not found');
    }

    if (!activity.video) {
      throw new BadRequestException('This activity has no video URL');
    }

    const baseUrl =
      process.env.TRANSCRIPTION_SERVICE_URL || 'http://127.0.0.1:5001';
    const pythonUrl = `${baseUrl}/transcribe`;

    // Resolver URL de Vimeo a URL de streaming directo si es necesario
    console.log(`🔍 Resolviendo URL de video: ${activity.video}`);
    const resolvedVideoUrl = await this.vimeoResolverService.resolveUrl(
      activity.video,
    );
    console.log(`✅ URL resuelta: ${resolvedVideoUrl}`);

    // Construir payload exactamente como espera el endpoint
    const payload: any = {
      video_url: resolvedVideoUrl,
      activity_id,
      name_activity: activity.name,
      use_gpu: use_gpu ?? false,
      generate_embeddings: generate_embeddings ?? true,
    };

    // Log sin mostrar propiedades undefined
    console.log('📤 Enviando solicitud de transcripción (payload limpio):', {
      pythonUrl,
      payload,
    });

    try {
      const response$ = this.httpService.post(pythonUrl, payload);
      const response = await lastValueFrom(response$);
      const data = response.data;

      console.log('📥 Respuesta completa del servidor de transcripción:', {
        status: data.status,
        jobId: data.job_id,
        fullResponse: data,
      });

      if (data.error) {
        throw new BadRequestException(`Transcription error: ${data.error}`);
      }

      if (!data.job_id) {
        throw new BadRequestException(
          `No job_id in response. Response: ${JSON.stringify(data)}`,
        );
      }

      // Guardar el job_id en la actividad
      await this.activitiesService.update(activity_id, {
        transcription_job_id: data.job_id,
      });

      console.log(
        `✅ Job ${data.job_id} enqueued y guardado en BD para activity ${activity_id}`,
      );

      // Iniciar polling asincrónico (NO await - se ejecuta en background)
      this.transcriptionPollingService.startPolling(data.job_id, activity_id);

      return {
        message: 'Transcription job enqueued successfully',
        jobId: data.job_id,
        status: data.status,
      };
    } catch (error: any) {
      console.error('❌ Error al enviar job al microservicio:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status,
      });

      throw new BadRequestException(
        `Failed to enqueue transcript job: ${
          error.response?.data?.error || error.message || 'Unknown error'
        }`,
      );
    }
  }

  @Get('transcription-status/:job_id')
  async getJobStatus(@Param('job_id') job_id: string) {
    const baseUrl =
      process.env.TRANSCRIPTION_SERVICE_URL || 'http://127.0.0.1:5001';
    const response$ = this.httpService.get(
      `${baseUrl}/transcribe/${job_id}/status`,
    );
    const response = await lastValueFrom(response$);
    return response.data;
  }

  // Validar y recuperar transcripts en "done"
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

        // Consultar estado del job
        const baseUrl =
          process.env.TRANSCRIPTION_SERVICE_URL || 'http://127.0.0.1:5001';
        const resultUrl = `${baseUrl}/transcribe/${jobId}/result`;
        const response$ = this.httpService.get(resultUrl);
        const response = await lastValueFrom(response$);
        const data = response.data;

        if (data.status === 'done' && data.segments) {
          console.log(
            `✅ Job ${jobId} está completo con ${data.segments.length} segmentos`,
          );

          // Guardar segmentos
          await this.transcriptSegmentsService.createSegments(
            String(activity._id),
            data.segments,
          );

          // Marcar como disponible
          await this.activitiesService.updateTranscriptAvailable(
            String(activity._id),
            true,
          );

          results.updated++;
          results.details.push({
            activityId: activity._id,
            jobId,
            status: 'done',
            segmentCount: data.segments.length,
            message: 'Transcript marcado como disponible',
          });

          console.log(
            `📝 Activity ${activity._id} marcada como transcript_available`,
          );
        } else if (data.status === 'processing') {
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
      // Consultar estado del job
      const baseUrl =
        process.env.TRANSCRIPTION_SERVICE_URL || 'http://127.0.0.1:5001';
      const resultUrl = `${baseUrl}/transcribe/${jobId}/result`;
      console.log(`📥 Consultando: ${resultUrl}`);

      const response$ = this.httpService.get(resultUrl);
      const response = await lastValueFrom(response$);
      const data = response.data;

      console.log(`📊 Status del job: ${data.status}`);

      if (data.status === 'done' && data.segments) {
        console.log(
          `✅ Job ${jobId} está completo con ${data.segments.length} segmentos`,
        );

        // Guardar segmentos
        await this.transcriptSegmentsService.createSegments(
          activity_id,
          data.segments,
        );

        // Marcar como disponible
        await this.activitiesService.updateTranscriptAvailable(
          activity_id,
          true,
        );

        const updatedActivity =
          await this.activitiesService.findOne(activity_id);

        console.log(
          `✏️ Activity ${activity_id} marcada como transcript_available`,
        );

        return {
          message: 'Transcription validated and saved successfully',
          activity: updatedActivity,
          status: 'done',
          segmentCount: data.segments.length,
        };
      } else if (data.status === 'processing') {
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
}
