import { Module } from '@nestjs/common';
import { ActivitiesService } from './activities.service';
import { ActivitiesController } from './activities.controller';
import { Activity, ActivitySchema } from './schemas/activity.schema';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { TranscriptSegmentsModule } from 'src/transcript-segments/transcript-segments.module';
import { TranscriptionPollingService } from './transcription-polling.service';
import { VimeoResolverService } from './vimeo-resolver.service';
import { BunnyResolverService } from './bunny-resolver.service';
import { AssemblyAiService } from './assemblyai.service';
import { DocumentsModule } from '../documents/documents.module';
import { MigrationTextTranscriptionService } from './migration-text-transcription.service';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Activity.name, schema: ActivitySchema },
    ]),
    HttpModule,
    TranscriptSegmentsModule,
    DocumentsModule,
    // Provee UsersService para SessionTokenGuard en los endpoints de
    // transcripción/migración.
    UsersModule,
  ],
  providers: [
    ActivitiesService,
    TranscriptionPollingService,
    VimeoResolverService,
    BunnyResolverService,
    AssemblyAiService,
    MigrationTextTranscriptionService,
  ],
  controllers: [ActivitiesController],
})
export class ActivitiesModule {}
