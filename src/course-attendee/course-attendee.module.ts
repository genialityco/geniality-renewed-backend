// course-attendee.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CourseAttendeeController } from './course-attendee.controller';
import { CourseAttendeeService } from './course-attendee.service';
import {
  CourseAttendee,
  CourseAttendeeSchema,
} from './schemas/course-attendee.schema';
import { Activity, ActivitySchema } from '../activities/schemas/activity.schema';
import { Event, EventSchema } from '../events/schemas/event.schema';
import { ActivityAttendeeModule } from '../activity-attendee/activity-attendee.module';
import { UsersModule } from '../users/users.module';
import {
  OrganizationUser,
  OrganizationUserSchema,
} from '../organization-users/schemas/organization-user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CourseAttendee.name, schema: CourseAttendeeSchema },
      { name: Activity.name, schema: ActivitySchema },
      { name: Event.name, schema: EventSchema },
      // Para OrgMembershipGuard (aislamiento por organización). Se registra el
      // schema aquí en vez de importar OrganizationUsersModule, que arrastra el
      // ciclo con PaymentPlansModule.
      { name: OrganizationUser.name, schema: OrganizationUserSchema },
    ]),
    ActivityAttendeeModule,
    // UsersModule (sin ciclos) provee UsersService para SessionTokenGuard y
    // para resolver el uid de Firebase en OrgMembershipGuard.
    UsersModule,
  ],
  controllers: [CourseAttendeeController],
  providers: [CourseAttendeeService],
  exports: [CourseAttendeeService],
})
export class CourseAttendeeModule {}
