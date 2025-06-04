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

@Controller('transcript-segments')
export class TranscriptSegmentsController {
  [x: string]: any;
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

    return {
      message: 'Segments saved successfully',
      total: segments.length,
    };
  }
}
