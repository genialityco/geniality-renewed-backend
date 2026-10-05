import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { TranscriptSegmentsService } from './transcript-segments.service';
import { ActivitiesService } from '../activities/activities.service';
import { SessionTokenGuard } from '../auth/session-token.guard';

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

  /**
   * Backfill global de embeddings faltantes, en cualquier actividad. Admite
   * `?limit=` (default 200) para no bloquear la request; si `remaining` sale
   * en > 0, hay que repetir la llamada hasta vaciar el backlog.
   */
  @Post('embeddings/backfill')
  @UseGuards(SessionTokenGuard)
  async backfillEmbeddings(@Query('limit') limit?: string) {
    return this.segmentsService.generateMissingEmbeddings(
      Number(limit) || 200,
    );
  }

  /**
   * Regenera TODOS los embeddings (de cualquier actividad), incluso los que
   * ya tienen uno. Paginado por cursor: la primera llamada va sin `after`;
   * si la respuesta trae `nextCursor`, hay que repetir pasando ese valor
   * en `?after=` hasta que salga `null`.
   */
  @Post('embeddings/regenerate-all')
  @UseGuards(SessionTokenGuard)
  async regenerateAllEmbeddings(
    @Query('limit') limit?: string,
    @Query('after') after?: string,
  ) {
    return this.segmentsService.generateAllEmbeddings(
      Number(limit) || 200,
      after,
    );
  }

  @Get(':activityId')
  async getSegments(@Param('activityId') activityId: string) {
    return this.segmentsService.getSegmentsByActivity(activityId);
  }

  /**
   * Vectorización manual de todos los segmentos de una actividad.
   * `?force=true` regenera incluso los que ya tienen embedding (p.ej. tras
   * cambiar de modelo/dimensión).
   */
  @Post(':activityId/embeddings')
  @UseGuards(SessionTokenGuard)
  async generateEmbeddingsForActivity(
    @Param('activityId') activityId: string,
    @Query('force') force?: string,
  ) {
    return this.segmentsService.generateEmbeddingsForActivity(
      activityId,
      force === 'true',
    );
  }

  @Post(':id/generate-embedding')
  @UseGuards(SessionTokenGuard)
  async generateEmbedding(@Param('id') segmentId: string) {
    return this.segmentsService.generateEmbeddingForSegment(segmentId);
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
