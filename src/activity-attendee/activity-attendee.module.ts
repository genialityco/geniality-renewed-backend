import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ActivityAttendeeController } from './activity-attendee.controller';
import { ActivityAttendeeService } from './activity-attendee.service';
import {
  ActivityAttendee,
  ActivityAttendeeSchema,
} from './schemas/activity-attendee.schema';
import {
  Activity,
  ActivitySchema,
} from '../activities/schemas/activity.schema';
import {
  CourseAttendee,
  CourseAttendeeSchema,
} from '../course-attendee/schemas/course-attendee.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ActivityAttendee.name, schema: ActivityAttendeeSchema },
      { name: Activity.name, schema: ActivitySchema },
      { name: CourseAttendee.name, schema: CourseAttendeeSchema },
    ]),
  ],
  controllers: [ActivityAttendeeController],
  providers: [ActivityAttendeeService],
  exports: [ActivityAttendeeService],
})
export class ActivityAttendeeModule {}
