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

  // (Opcional) Endpoint para generar transcripciones (ejemplo con microservicio Python).
  @Post('generate-transcript/:activity_id')
  async generateTranscript(@Param('activity_id') activity_id: string) {
    // 1) Recuperar la actividad
    const activity = await this.activitiesService.findOne(activity_id);
    if (!activity) {
      throw new NotFoundException('Activity not found');
    }

    if (!activity.video) {
      throw new BadRequestException('This activity has no video URL');
    }

    // 2) Preparar la petición al microservicio Python
    const pythonUrl = 'http://localhost:5001/transcribe'; // Ajustar según tu despliegue
    const payload = {
      vimeo_url: activity.video,
      engine: 'whisper',
      model_name: 'tiny',
      language: 'es',
    };

    // 3) Llamada HTTP al servicio Python
    try {
      const response$ = this.httpService.post(pythonUrl, payload);
      const response = await lastValueFrom(response$); // Convertir Observable a Promise
      const data = response.data; // p.ej. { status, engine_used, transcription, segments }

      if (data.error) {
        throw new BadRequestException(`Transcription error: ${data.error}`);
      }

      // 4) Guardar segmentos en Mongo (p.ej. en tu transcriptSegmentsService)
      const segmentsData = data.segments.map((seg) => ({
        startTime: seg.start_time,
        endTime: seg.end_time,
        text: seg.text,
        embedding: seg.segment_embedding,
      }));

      await this.transcriptSegmentsService.createSegments(
        activity_id,
        segmentsData,
      );

      return {
        message: 'Transcript generated successfully',
        totalSegments: segmentsData.length,
      };
    } catch (error) {
      throw new BadRequestException(`Failed to generate transcript: ${error}`);
    }
  }
}
