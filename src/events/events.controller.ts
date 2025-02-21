import { Controller, Get, Param } from '@nestjs/common';
import { EventsService } from './events.service';
import { Event } from './schemas/event.schema';

@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Get()
  async getAllEvents(): Promise<Event[]> {
    return this.eventsService.findAll();
  }

  @Get(':id')
  async getEventById(@Param('id') id: string): Promise<Event | null> {
    return this.eventsService.findById(id);
  }

  @Get('organizer/:organizerId')
  async getEventsByOrganizer(
    @Param('organizerId') organizerId: string,
  ): Promise<Event[]> {
    return this.eventsService.findByOrganizer(organizerId);
  }
}
