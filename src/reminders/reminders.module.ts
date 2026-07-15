import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MongooseModule } from '@nestjs/mongoose';
import { RemindersService } from './reminders.service';
import { RemindersCron } from './reminders.cron';
import { RemindersController } from './reminders.controller';
import { WeeklyReportService } from './weekly-report.service';
import { WhatsappGatewayClient } from './whatsapp-gateway.client';
import {
  UserActivitySnapshot,
  UserActivitySnapshotSchema,
} from './schemas/user-activity-snapshot.schema';
import { UserActivityModule } from 'src/user-activity/user-activity.module';
import { UsersModule } from 'src/users/users.module';
import { OrganizationsModule } from 'src/organizations/organizations.module';
import { OrganizationUsersModule } from 'src/organization-users/organization-users.module';

@Module({
  imports: [
    HttpModule,
    MongooseModule.forFeature([
      { name: UserActivitySnapshot.name, schema: UserActivitySnapshotSchema },
    ]),
    UserActivityModule,
    UsersModule,
    OrganizationsModule,
    OrganizationUsersModule,
  ],
  providers: [
    RemindersService,
    WeeklyReportService,
    WhatsappGatewayClient,
    RemindersCron,
  ],
  controllers: [RemindersController],
})
export class RemindersModule {}
