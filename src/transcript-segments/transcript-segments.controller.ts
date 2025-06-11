import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { TranscriptSegmentsService } from './transcript-segments.service';
import { ActivitiesService } from '../activities/activities.service';

@Controller('transcript-segments')
export class TranscriptSegmentsController {
  [x: string]: any;
  constructor(
    private readonly segmentsService: TranscriptSegmentsService,
    private readonly activitiesService: ActivitiesService, // inyectar el servicio de actividades
  ) {}

  @Get('search')
  async searchSegments(
    @Query('q') query: string,
    @Query('page') page = 1,
    @Query('pageSize') pageSize = 10,
  ) {
    if (!query) {
      return { data: [], total: 0 };
    }
    const pageNum = Number(page) || 1;
    const pageSizeNum = Number(pageSize) || 10;

    return this.segmentsService.searchSegmentsGroupedByActivity(
      query,
      pageNum,
      pageSizeNum,
    );
  }

  @Get(':activityId')
  async getSegments(@Param('activityId') activityId: string) {
    return this.segmentsService.getSegmentsByActivity(activityId);
  }
  @Post(':id')
  async createSegmentsUnified(
    @Param('id') activityId: string,
    @Body() body: any,
  ) {
    const segments = body?.segmentsData ?? body?.segments ?? []; // acepta ambos nombres

    if (!Array.isArray(segments) || segments.length === 0) {
      throw new BadRequestException('No hay segmentos válidos en el body.');
    }

    await this.segmentsService.createSegments(activityId, segments);

    // Actualizar transcript_available a true
    await this.activitiesService.updateTranscriptAvailable(activityId, true);

    return {
      message: 'Segments saved successfully',
      total: segments.length,
    };
  }
}
