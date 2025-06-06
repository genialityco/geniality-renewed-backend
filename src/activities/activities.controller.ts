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
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';

@Controller('activities')
export class ActivitiesController {
  constructor(
    private readonly activitiesService: ActivitiesService,
    private readonly transcriptSegmentsService: TranscriptSegmentsService,
    private readonly httpService: HttpService,
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
  ): Promise<Activity[]> {
    return this.activitiesService.findByOrganization(organizationId);
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

  // (Opcional) Endpoint para generar transcripciones (ejemplo con microservicio Python).@Post('generate-transcript/:activity_id')
  @Post('generate-transcript/:activity_id')
  async generateTranscript(@Param('activity_id') activity_id: string) {
    const activity = await this.activitiesService.findOne(activity_id);
    if (!activity) {
      throw new NotFoundException('Activity not found');
    }

    if (!activity.video) {
      throw new BadRequestException('This activity has no video URL');
    }

    // Normalizar la URL de Vimeo antes de enviarla
    const normalizedVimeoUrl = this.normalizeVimeoUrl(activity.video);

    const pythonUrl =
      'https://theories-jacket-banners-copy.trycloudflare.com/enqueue';
    const payload = {
      vimeo_url: normalizedVimeoUrl,
      activity_id, // lo necesita el microservicio para notificar después
    };

    try {
      const response$ = this.httpService.post(pythonUrl, payload);
      const response = await lastValueFrom(response$);
      const data = response.data;

      if (data.error) {
        throw new BadRequestException(`Transcription error: ${data.error}`);
      }

      // ...antes del return
      await this.activitiesService.update(activity_id, {
        transcription_job_id: data.job_id,
      });

      return {
        message: 'Transcription job enqueued successfully',
        jobId: data.job_id,
      };
    } catch (error) {
      console.error('❌ Error al enviar job al microservicio:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status,
        stack: error.stack,
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
    const response$ = this.httpService.get(
      `https://theories-jacket-banners-copy.trycloudflare.com/status/${job_id}`,
    );
    const response = await lastValueFrom(response$);
    return response.data;
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
