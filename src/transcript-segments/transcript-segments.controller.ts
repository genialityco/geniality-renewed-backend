import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { TranscriptSegmentsService } from './transcript-segments.service';

@Controller('transcript-segments')
export class TranscriptSegmentsController {
  constructor(private readonly segmentsService: TranscriptSegmentsService) {}

  @Get('search')
  async searchSegments(@Query('q') query: string) {
    if (!query) {
      return [];
    }
    return this.segmentsService.searchSegmentsGroupedByActivity(query);
  }

  @Get(':activityId')
  async getSegments(@Param('activityId') activityId: string) {
    return this.segmentsService.getSegmentsByActivity(activityId);
  }

  // Crear o sobreescribir los segmentos de una actividad
  @Post(':activityId')
  async createSegments(
    @Param('activityId') activityId: string,
    @Body()
    body: {
      segmentsData: Array<{
        startTime: number;
        endTime: number;
        text: string;
        embedding?: number[];
      }>;
    },
  ) {
    return this.segmentsService.createSegments(activityId, body.segmentsData);
  }
}
