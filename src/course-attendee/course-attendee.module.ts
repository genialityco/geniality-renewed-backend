// course-attendee.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CourseAttendeeController } from './course-attendee.controller';
import { CourseAttendeeService } from './course-attendee.service';
import {
  CourseAttendee,
  CourseAttendeeSchema,
} from './schemas/course-attendee.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CourseAttendee.name, schema: CourseAttendeeSchema },
    ]),
  ],
  controllers: [CourseAttendeeController],
  providers: [CourseAttendeeService],
  exports: [CourseAttendeeService],
})
export class CourseAttendeeModule {}
