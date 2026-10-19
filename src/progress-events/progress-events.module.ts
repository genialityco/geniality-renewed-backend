import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProgressEventsService } from './progress-events.service';
import {
  ProgressEvent,
  ProgressEventSchema,
} from './schemas/progress-event.schema';
import {
  CourseAttendee,
  CourseAttendeeSchema,
} from '../course-attendee/schemas/course-attendee.schema';

// Sin dependencias de otros módulos para que ActivityAttendeeModule y
// CourseAttendeeModule puedan importarlo sin ciclos.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ProgressEvent.name, schema: ProgressEventSchema },
      { name: CourseAttendee.name, schema: CourseAttendeeSchema },
    ]),
  ],
  providers: [ProgressEventsService],
  exports: [ProgressEventsService, MongooseModule],
})
export class ProgressEventsModule {}
