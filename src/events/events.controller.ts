import {
  Controller,
  Get,
  Param,
  Body,
  Post,
  Patch,
  Delete,
} from '@nestjs/common';
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

  @Get('search/by-name/:name')
  async getEventByName(@Param('name') name: string): Promise<Event | null> {
    return this.eventsService.findByName(name);
  }

  // Crear evento (POST /events)
  @Post()
  async createEvent(@Body() body: any): Promise<Event> {
    return this.eventsService.createEvent(body);
  }

  // Actualizar evento (PATCH /events/:id)
  @Patch(':id')
  async updateEvent(
    @Param('id') id: string,
    @Body() body: any,
  ): Promise<Event> {
    return this.eventsService.updateEvent(id, body);
  }

  // Eliminar evento (DELETE /events/:id)
  @Delete(':id')
  async deleteEvent(@Param('id') id: string): Promise<Event> {
    return this.eventsService.deleteEvent(id);
  }
}
