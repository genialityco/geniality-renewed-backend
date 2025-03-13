import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Put,
  Delete,
} from '@nestjs/common';
import { ActivityAttendeeService } from './activity-attendee.service';
import { ActivityAttendee } from './schemas/activity-attendee.schema';

@Controller('activity-attendees')
export class ActivityAttendeeController {
  constructor(private readonly service: ActivityAttendeeService) {}

  @Post()
  async create(@Body() createDto: any): Promise<ActivityAttendee> {
    return this.service.create(createDto);
  }

  @Post('create-or-update')
  async createOrUpdate(@Body() body: any): Promise<ActivityAttendee> {
    const { user_id, activity_id, progress } = body;
    return this.service.createOrUpdate(user_id, activity_id, progress);
  }

  @Get()
  async findAll(): Promise<ActivityAttendee[]> {
    return this.service.findAll();
  }

  @Get(':id')
  async findById(@Param('id') id: string): Promise<ActivityAttendee> {
    return this.service.findById(id);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() updateDto: any,
  ): Promise<ActivityAttendee> {
    return this.service.update(id, updateDto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<ActivityAttendee> {
    return this.service.remove(id);
  }
}
