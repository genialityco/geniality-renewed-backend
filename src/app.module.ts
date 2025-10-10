import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { OrganizationsModule } from './organizations/organizations.module';
import { EventsModule } from './events/events.module';
import { ModulesModule } from './modules/modules.module';
import { ActivitiesModule } from './activities/activities.module';
import { QuestionnaireModule } from './questionnaire/questionnaire.module';
import { TranscriptSegmentsModule } from './transcript-segments/transcript-segments.module';
import { HostsModule } from './hosts/hosts.module';
import { UsersModule } from './users/users.module';
import { CourseAttendeeModule } from './course-attendee/course-attendee.module';
import { ActivityAttendeeModule } from './activity-attendee/activity-attendee.module';
import { QuizModule } from './quiz/quiz.module';
import { QuizAttemptModule } from './quiz-attempt/quiz-attempt.module';
import { PaymentPlansModule } from './payment-plans/payment-plans.module';
import { OrganizationUsersModule } from './organization-users/organization-users.module';
import { EmailModule } from './email/email.module';
import { PaymentRequestsModule } from './payment-requests/payment-requests.module';
// import { SessionTokenGuard } from './auth/session-token.guard';
import { WompiModule } from './wompi/wompi.module';
import { PaymentLogsModule } from './payment-logs/payment-logs.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRoot(process.env.MONGO_URI),
    ScheduleModule.forRoot(),
    OrganizationsModule,
    EventsModule,
    ModulesModule,
    ActivitiesModule,
    QuestionnaireModule,
    TranscriptSegmentsModule,
    HostsModule,
    UsersModule,
    CourseAttendeeModule,
    ActivityAttendeeModule,
    QuizModule,
    QuizAttemptModule,
    PaymentPlansModule,
    OrganizationUsersModule,
    EmailModule,
    PaymentRequestsModule,
    WompiModule,
    PaymentLogsModule,
  ],
  // providers: [SessionTokenGuard],
})
export class AppModule {}
