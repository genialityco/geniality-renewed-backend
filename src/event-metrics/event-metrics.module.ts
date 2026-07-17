import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EventMetricsController } from './event-metrics.controller';
import { EventMetricsService } from './event-metrics.service';
import { Event, EventSchema } from '../events/schemas/event.schema';
import {
  CourseAttendee,
  CourseAttendeeSchema,
} from '../course-attendee/schemas/course-attendee.schema';
import {
  ActivityAttendee,
  ActivityAttendeeSchema,
} from '../activity-attendee/schemas/activity-attendee.schema';
import { Activity, ActivitySchema } from '../activities/schemas/activity.schema';
import { ModuleSchema } from '../modules/schemas/module.schema';
import {
  UserActivity,
  UserActivitySchema,
} from '../user-activity/schemas/user-activity.schema';
import { Quiz, QuizSchema } from '../quiz/schemas/quiz.schema';
import {
  UserQuizAttempt,
  UserQuizAttemptSchema,
} from '../user-quiz-attempt/schemas/user-quiz-attempt.schema';
import {
  Certificate,
  CertificateSchema,
} from '../certificates/schemas/certificate.schema';
import {
  OrganizationUser,
  OrganizationUserSchema,
} from '../organization-users/schemas/organization-user.schema';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Event.name, schema: EventSchema },
      { name: CourseAttendee.name, schema: CourseAttendeeSchema },
      { name: ActivityAttendee.name, schema: ActivityAttendeeSchema },
      { name: Activity.name, schema: ActivitySchema },
      { name: 'Module', schema: ModuleSchema },
      { name: UserActivity.name, schema: UserActivitySchema },
      { name: Quiz.name, schema: QuizSchema },
      { name: UserQuizAttempt.name, schema: UserQuizAttemptSchema },
      { name: Certificate.name, schema: CertificateSchema },
      // Para OrgMembershipGuard (aislamiento por organización), sin importar
      // OrganizationUsersModule que arrastra el ciclo con PaymentPlansModule.
      { name: OrganizationUser.name, schema: OrganizationUserSchema },
    ]),
    // Provee UsersService para SessionTokenGuard y OrgMembershipGuard.
    UsersModule,
  ],
  controllers: [EventMetricsController],
  providers: [EventMetricsService],
  exports: [EventMetricsService],
})
export class EventMetricsModule {}
