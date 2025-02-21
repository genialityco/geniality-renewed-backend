import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Put,
  Delete,
} from '@nestjs/common';
import { ActivitiesService } from './activities.service';
import { Activity } from './schemas/activity.schema';

@Controller('activities')
export class ActivitiesController {
  constructor(private readonly activitiesService: ActivitiesService) {}

  @Post()
  async create(@Body() activity: Activity): Promise<Activity> {
    return this.activitiesService.create(activity);
  }

  @Get()
  async findAll(): Promise<Activity[]> {
    return this.activitiesService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<Activity> {
    return this.activitiesService.findOne(id);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() activity: Partial<Activity>,
  ): Promise<Activity> {
    return this.activitiesService.update(id, activity);
  }

  @Delete(':id')
  async delete(@Param('id') id: string): Promise<Activity> {
    return this.activitiesService.delete(id);
  }

  @Get('event/:event_id')
  async findByEventId(
    @Param('event_id') event_id: string,
  ): Promise<Activity[]> {
    return this.activitiesService.findByEventId(event_id);
  }

  @Put(':id/video-progress')
  async updateVideoProgress(
    @Param('id') id: string,
    @Body('progress') progress: number,
  ): Promise<Activity> {
    return this.activitiesService.updateVideoProgress(id, progress);
  }
}
