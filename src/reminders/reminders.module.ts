import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MongooseModule } from '@nestjs/mongoose';
import { RemindersService } from './reminders.service';
import { RemindersCron } from './reminders.cron';
import { RemindersController } from './reminders.controller';
import { WeeklyReportService } from './weekly-report.service';
import { CourseRankingService } from './course-ranking.service';
import { WhatsappGatewayClient } from './whatsapp-gateway.client';
import {
  UserActivitySnapshot,
  UserActivitySnapshotSchema,
} from './schemas/user-activity-snapshot.schema';
import { UserActivityModule } from 'src/user-activity/user-activity.module';
import { UsersModule } from 'src/users/users.module';
import { OrganizationsModule } from 'src/organizations/organizations.module';
import { OrganizationUsersModule } from 'src/organization-users/organization-users.module';
import { CourseAttendeeModule } from 'src/course-attendee/course-attendee.module';
import { EngagementModule } from 'src/engagement/engagement.module';
import { GenOnModule } from 'src/genon/genon.module';
import {
  Organization,
  OrganizationSchema,
} from 'src/organizations/schemas/organization.schema';
import {
  OrganizationUser,
  OrganizationUserSchema,
} from 'src/organization-users/schemas/organization-user.schema';

@Module({
  imports: [
    HttpModule,
    MongooseModule.forFeature([
      { name: UserActivitySnapshot.name, schema: UserActivitySnapshotSchema },
      // Para OrgAdminGuard
      { name: Organization.name, schema: OrganizationSchema },
      { name: OrganizationUser.name, schema: OrganizationUserSchema },
    ]),
    UserActivityModule,
    UsersModule,
    OrganizationsModule,
    OrganizationUsersModule,
    CourseAttendeeModule,
    // Bitácora de envíos: deduplicación, tope semanal y grupo de control
    EngagementModule,
    // Organizaciones con Gen.ON activo: ahí no salen estos recordatorios
    GenOnModule,
  ],
  providers: [
    RemindersService,
    WeeklyReportService,
    CourseRankingService,
    WhatsappGatewayClient,
    RemindersCron,
  ],
  controllers: [RemindersController],
})
export class RemindersModule {}
