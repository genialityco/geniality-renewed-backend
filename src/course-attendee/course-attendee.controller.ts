// course-attendee.controller.ts
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Put,
  Delete,
} from '@nestjs/common';
import { CourseAttendeeService } from './course-attendee.service';
import { CourseAttendee } from './schemas/course-attendee.schema';

@Controller('course-attendees')
export class CourseAttendeeController {
  constructor(private readonly service: CourseAttendeeService) {}

  @Post()
  async create(@Body() createDto: any): Promise<CourseAttendee> {
    return this.service.create(createDto);
  }

  @Post('create-or-update')
  async createOrUpdate(@Body() body: any): Promise<CourseAttendee> {
    const { user_id, event_id, status } = body;
    return this.service.createOrUpdate(user_id, event_id, status);
  }

  @Get()
  async findAll(): Promise<CourseAttendee[]> {
    return this.service.findAll();
  }

  @Get(':id')
  async findById(@Param('id') id: string): Promise<CourseAttendee> {
    return this.service.findById(id);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() updateDto: any,
  ): Promise<CourseAttendee> {
    return this.service.update(id, updateDto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<CourseAttendee> {
    return this.service.remove(id);
  }
}
