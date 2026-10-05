import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  TranscriptSegment,
  TranscriptSegmentSchema,
} from './schemas/transcript-segment.schema';
import { TranscriptSegmentsService } from './transcript-segments.service';
import { TranscriptSegmentsController } from './transcript-segments.controller';
import { EmbeddingService } from './embedding.service';
import { ActivitiesService } from 'src/activities/activities.service';
import {
  Activity,
  ActivitySchema,
} from 'src/activities/schemas/activity.schema';
import { UsersModule } from 'src/users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TranscriptSegment.name, schema: TranscriptSegmentSchema },
      { name: Activity.name, schema: ActivitySchema }, // importar el modelo Activity
    ]),
    // Provee UsersService para SessionTokenGuard en los endpoints de
    // generación/backfill de embeddings.
    UsersModule,
  ],
  providers: [TranscriptSegmentsService, ActivitiesService, EmbeddingService],
  controllers: [TranscriptSegmentsController],
  exports: [TranscriptSegmentsService],
})
export class TranscriptSegmentsModule {}
