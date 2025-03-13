import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ActivityAttendeeController } from './activity-attendee.controller';
import { ActivityAttendeeService } from './activity-attendee.service';
import {
  ActivityAttendee,
  ActivityAttendeeSchema,
} from './schemas/activity-attendee.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ActivityAttendee.name, schema: ActivityAttendeeSchema },
    ]),
  ],
  controllers: [ActivityAttendeeController],
  providers: [ActivityAttendeeService],
  exports: [ActivityAttendeeService],
})
export class ActivityAttendeeModule {}
