import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CourseSnapshotsController } from './course-snapshots.controller';
import { CourseSnapshotsService } from './course-snapshots.service';
import { CourseSnapshotsCron } from './course-snapshots.cron';
import {
  CourseSnapshot,
  CourseSnapshotSchema,
} from './schemas/course-snapshot.schema';
import {
  CourseSnapshotUser,
  CourseSnapshotUserSchema,
} from './schemas/course-snapshot-user.schema';
import {
  CourseUserState,
  CourseUserStateSchema,
} from './schemas/course-user-state.schema';
import {
  EngagementMessage,
  EngagementMessageSchema,
} from '../engagement/schemas/engagement-message.schema';
import { Event, EventSchema } from '../events/schemas/event.schema';
import {
  CourseAttendee,
  CourseAttendeeSchema,
} from '../course-attendee/schemas/course-attendee.schema';
import {
  ActivityAttendee,
  ActivityAttendeeSchema,
} from '../activity-attendee/schemas/activity-attendee.schema';
import {
  Activity,
  ActivitySchema,
} from '../activities/schemas/activity.schema';
import {
  UserActivity,
  UserActivitySchema,
} from '../user-activity/schemas/user-activity.schema';
import {
  Certificate,
  CertificateSchema,
} from '../certificates/schemas/certificate.schema';
import {
  OrganizationUser,
  OrganizationUserSchema,
} from '../organization-users/schemas/organization-user.schema';
import {
  Organization,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CourseSnapshot.name, schema: CourseSnapshotSchema },
      { name: CourseSnapshotUser.name, schema: CourseSnapshotUserSchema },
      { name: CourseUserState.name, schema: CourseUserStateSchema },
      // Último mensaje recibido por cada estudiante en la lista de seguimiento
      { name: EngagementMessage.name, schema: EngagementMessageSchema },
      { name: Event.name, schema: EventSchema },
      { name: CourseAttendee.name, schema: CourseAttendeeSchema },
      { name: ActivityAttendee.name, schema: ActivityAttendeeSchema },
      { name: Activity.name, schema: ActivitySchema },
      { name: UserActivity.name, schema: UserActivitySchema },
      { name: Certificate.name, schema: CertificateSchema },
      // OrgAdminGuard + teléfono/opt-in/nombre de los inscritos; sin importar
      // OrganizationUsersModule, que arrastra el ciclo con PaymentPlansModule.
      { name: OrganizationUser.name, schema: OrganizationUserSchema },
      { name: Organization.name, schema: OrganizationSchema },
      { name: User.name, schema: UserSchema },
    ]),
    // Provee UsersService para SessionTokenGuard y OrgAdminGuard.
    UsersModule,
  ],
  controllers: [CourseSnapshotsController],
  providers: [CourseSnapshotsService, CourseSnapshotsCron],
})
export class CourseSnapshotsModule {}
