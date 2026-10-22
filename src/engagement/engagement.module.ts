import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  EngagementMessage,
  EngagementMessageSchema,
} from './schemas/engagement-message.schema';
import {
  OrganizationUser,
  OrganizationUserSchema,
} from '../organization-users/schemas/organization-user.schema';
import {
  Organization,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import {
  ProgressEvent,
  ProgressEventSchema,
} from '../progress-events/schemas/progress-event.schema';
import { Event, EventSchema } from '../events/schemas/event.schema';
import {
  UserActivityDay,
  UserActivityDaySchema,
} from '../user-activity/schemas/user-activity-day.schema';
import {
  PracticeSession,
  PracticeSessionSchema,
} from '../ai-evaluations/schemas/practice-session.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import {
  CourseAttendee,
  CourseAttendeeSchema,
} from '../course-attendee/schemas/course-attendee.schema';
import { UsersModule } from '../users/users.module';
import { EngagementLogService } from './engagement-log.service';
import { EngagementReportService } from './engagement-report.service';
import { EngagementController } from './engagement.controller';
import { EngagementWebhookController } from './engagement-webhook.controller';
import { WhatsappOptOutService } from './whatsapp-opt-out.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EngagementMessage.name, schema: EngagementMessageSchema },
      // Sin importar OrganizationUsersModule, que arrastra el ciclo con
      // PaymentPlansModule. Organization + OrganizationUser: OrgAdminGuard.
      { name: OrganizationUser.name, schema: OrganizationUserSchema },
      { name: Organization.name, schema: OrganizationSchema },
      { name: User.name, schema: UserSchema },
      // Reporte: avance de los estudiantes después de cada envío
      { name: ProgressEvent.name, schema: ProgressEventSchema },
      { name: Event.name, schema: EventSchema },
      { name: UserActivityDay.name, schema: UserActivityDaySchema },
      { name: PracticeSession.name, schema: PracticeSessionSchema },
      // Avance del curso al momento de cada envío
      { name: CourseAttendee.name, schema: CourseAttendeeSchema },
    ]),
    // Provee UsersService para SessionTokenGuard y OrgAdminGuard.
    UsersModule,
  ],
  controllers: [EngagementController, EngagementWebhookController],
  providers: [
    EngagementLogService,
    EngagementReportService,
    WhatsappOptOutService,
  ],
  exports: [EngagementLogService, WhatsappOptOutService],
})
export class EngagementModule {}
