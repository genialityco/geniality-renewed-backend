import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { RemindersService } from './reminders.service';
import { RemindersCron } from './reminders.cron';
import { RemindersController } from './reminders.controller';
import { UserActivityModule } from 'src/user-activity/user-activity.module';
import { UsersModule } from 'src/users/users.module';
import { OrganizationsModule } from 'src/organizations/organizations.module';
import { OrganizationUsersModule } from 'src/organization-users/organization-users.module';

@Module({
  imports: [
    HttpModule,
    UserActivityModule,
    UsersModule,
    OrganizationsModule,
    OrganizationUsersModule,
  ],
  providers: [RemindersService, RemindersCron],
  controllers: [RemindersController],
})
export class RemindersModule {}
