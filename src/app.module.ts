import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
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
  ],
})
export class AppModule {}
