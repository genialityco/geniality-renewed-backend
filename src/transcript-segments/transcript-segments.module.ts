import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  TranscriptSegment,
  TranscriptSegmentSchema,
} from './schemas/transcript-segment.schema';
import { TranscriptSegmentsService } from './transcript-segments.service';
import { TranscriptSegmentsController } from './transcript-segments.controller';
import { ActivitiesService } from 'src/activities/activities.service';
import {
  Activity,
  ActivitySchema,
} from 'src/activities/schemas/activity.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TranscriptSegment.name, schema: TranscriptSegmentSchema },
      { name: Activity.name, schema: ActivitySchema }, // importar el modelo Activity
    ]),
  ],
  providers: [TranscriptSegmentsService, ActivitiesService],
  controllers: [TranscriptSegmentsController],
  exports: [TranscriptSegmentsService],
})
export class TranscriptSegmentsModule {}
