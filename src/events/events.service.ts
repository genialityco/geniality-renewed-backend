// events.service.ts

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Event } from './schemas/event.schema';

@Injectable()
export class EventsService {
  constructor(@InjectModel(Event.name) private eventModel: Model<Event>) {}

  async findAll(): Promise<Event[]> {
    return this.eventModel.find().exec();
  }

  async findById(id: string): Promise<Event | null> {
    return this.eventModel.findById(id).exec();
  }

  async findByOrganizer(organizerId: string): Promise<Event[]> {
    return this.eventModel.find({ organizer_id: organizerId }).exec();
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // Evita errores si el usuario ingresa símbolos especiales
  }

  async findByName(name: string): Promise<Event[]> {
    const escapedName = this.escapeRegex(name);
    return this.eventModel
      .find({
        name: { $regex: escapedName, $options: 'i' }, // 'i' = case-insensitive
      })
      .exec();
  }

  // Crear evento
  async createEvent(eventData: any): Promise<Event> {
    const createdEvent = new this.eventModel(eventData);
    return createdEvent.save();
  }

  // Actualizar evento
  async updateEvent(id: string, eventData: any): Promise<Event> {
    return this.eventModel.findByIdAndUpdate(id, eventData, {
      new: true,
      runValidators: true,
    });
  }

  // Eliminar evento
  async deleteEvent(id: string): Promise<Event> {
    return this.eventModel.findByIdAndDelete(id);
  }
}
