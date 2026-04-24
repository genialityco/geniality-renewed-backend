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
import { DocumentsService } from '../documents/documents.service';

@Controller('events')
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly documentsService: DocumentsService,
  ) {}

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
  async getEventsByName(@Param('name') name: string): Promise<Event[]> {
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

  // Obtener documentos asociados a un evento
  @Get(':eventId/documents')
  async getEventDocuments(@Param('eventId') eventId: string) {
    const event = await this.eventsService.findById(eventId);
    if (!event) {
      throw new Error('Event not found');
    }
    return this.documentsService.getDocumentsByOrganization(event.organizer_id.toString(), {
      eventId,
    });
  }
}
