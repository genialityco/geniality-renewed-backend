import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  TranscriptSegment,
  TranscriptSegmentSchema,
} from './schemas/transcript-segment.schema';
import { TranscriptSegmentsService } from './transcript-segments.service';
import { TranscriptSegmentsController } from './transcript-segments.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TranscriptSegment.name, schema: TranscriptSegmentSchema },
    ]),
  ],
  providers: [TranscriptSegmentsService],
  controllers: [TranscriptSegmentsController],
  exports: [TranscriptSegmentsService],
})
export class TranscriptSegmentsModule {}
