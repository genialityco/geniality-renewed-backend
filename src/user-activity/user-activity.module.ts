import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UserActivityController } from './user-activity.controller';
import { UserActivityService } from './user-activity.service';
import {
  UserActivity,
  UserActivitySchema,
} from './schemas/user-activity.schema';
import {
  UserActivityDay,
  UserActivityDaySchema,
} from './schemas/user-activity-day.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserActivity.name, schema: UserActivitySchema },
      { name: UserActivityDay.name, schema: UserActivityDaySchema },
    ]),
  ],
  controllers: [UserActivityController],
  providers: [UserActivityService],
  exports: [UserActivityService],
})
export class UserActivityModule {}
