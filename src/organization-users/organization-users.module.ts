import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  OrganizationUser,
  OrganizationUserSchema,
} from './schemas/organization-user.schema';
import { OrganizationUsersService } from './organization-users.service';
import { OrganizationUsersController } from './organization-users.controller';
import { EmailModule } from 'src/email/email.module';
import { UsersModule } from 'src/users/users.module';
import { PaymentPlansModule } from 'src/payment-plans/payment-plans.module';
import {
  Organization,
  OrganizationSchema,
} from 'src/organizations/schemas/organization.schema';
import {
  CourseAttendee,
  CourseAttendeeSchema,
} from 'src/course-attendee/schemas/course-attendee.schema';
import {
  ActivityAttendee,
  ActivityAttendeeSchema,
} from 'src/activity-attendee/schemas/activity-attendee.schema';
import {
  UserActivity,
  UserActivitySchema,
} from 'src/user-activity/schemas/user-activity.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OrganizationUser.name, schema: OrganizationUserSchema },
      { name: Organization.name, schema: OrganizationSchema },
      // Para limpiar el progreso del usuario al eliminarlo (ver
      // deleteOrganizationUser): sin esto, borrar un miembro deja huérfanos
      // en estas colecciones (referencian user_id pero nadie los borra).
      { name: CourseAttendee.name, schema: CourseAttendeeSchema },
      { name: ActivityAttendee.name, schema: ActivityAttendeeSchema },
      { name: UserActivity.name, schema: UserActivitySchema },
    ]),
    EmailModule,
    UsersModule,
    forwardRef(() => PaymentPlansModule),
  ],
  controllers: [OrganizationUsersController],
  providers: [OrganizationUsersService],
  exports: [OrganizationUsersService],
})
export class OrganizationUsersModule { }
