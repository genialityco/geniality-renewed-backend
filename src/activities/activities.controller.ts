import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Put,
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

  @Post()
  async create(@Body() activity: Activity): Promise<Activity> {
    return this.activitiesService.create(activity);
  }

  @Get('by-organization')
  async findByOrganization(
    @Query('organizationId') organizationId?: string,
  ): Promise<Activity[]> {
    return this.activitiesService.findByOrganization(organizationId);
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<Activity> {
    return this.activitiesService.findOne(id);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() activity: Partial<Activity>,
  ): Promise<Activity> {
    return this.activitiesService.update(id, activity);
  }

  @Delete(':id')
  async delete(@Param('id') id: string): Promise<Activity> {
    return this.activitiesService.delete(id);
  }

  @Get('event/:event_id')
  async findByEventId(
    @Param('event_id') event_id: string,
  ): Promise<Activity[]> {
    return this.activitiesService.findByEventId(event_id);
  }

  @Put(':id/video-progress')
  async updateVideoProgress(
    @Param('id') id: string,
    @Body('progress') progress: number,
  ): Promise<Activity> {
    return this.activitiesService.updateVideoProgress(id, progress);
  }

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
    const pythonUrl = 'http://localhost:5001/transcribe';
    // Ajusta el host/puerto según tu despliegue (Docker, etc.)

    const payload = {
      vimeo_url: activity.video, // la URL de Vimeo que tengas en el campo 'video'
      engine: 'whisper', // Nombre del engine en el server Python
      model_name: 'tiny', // Cambia a 'base', 'medium', etc. si quieres
      language: 'es', // Opcional: Forzar idioma si Whisper lo soporta
    };

    // 3) Llamada HTTP al servicio Python
    try {
      const response$ = this.httpService.post(pythonUrl, payload);
      const response = await lastValueFrom(response$); // Convertir Observable -> Promise

      const data = response.data; // data = { status, engine_used, transcription, segments }

      if (data.error) {
        throw new BadRequestException(`Transcription error: ${data.error}`);
      }

      // 4) Guardar los segmentos en nuestra BD (Mongo)
      // data.segments es un array de:
      // [ { start_time, end_time, text, segment_embedding }, ... ]
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
