import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { OrganizationsModule } from './organizations/organizations.module';
import { EventsModule } from './events/events.module';
import { ModulesModule } from './modules/modules.module';
import { ActivitiesModule } from './activities/activities.module';
import { QuestionnaireModule } from './questionnaire/questionnaire.module';
import { TranscriptSegmentsModule } from './transcript-segments/transcript-segments.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRoot(process.env.MONGO_URI),
    OrganizationsModule,
    EventsModule,
    ModulesModule,
    ActivitiesModule,
    QuestionnaireModule,
    TranscriptSegmentsModule,
  ],
})
export class AppModule {}
