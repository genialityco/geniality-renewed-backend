// course-attendee.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CourseAttendee } from './schemas/course-attendee.schema';

@Injectable()
export class CourseAttendeeService {
  constructor(
    @InjectModel(CourseAttendee.name)
    private readonly courseAttendeeModel: Model<CourseAttendee>,
  ) {}

  async create(createDto: any): Promise<CourseAttendee> {
    // createDto debería contener { user_id, course_id, status? }
    const record = new this.courseAttendeeModel(createDto);
    return record.save();
  }

  async createOrUpdate(
    userId: string,
    eventId: string,
    progress: number,
  ): Promise<CourseAttendee> {
    const existing = await this.courseAttendeeModel.findOne({
      user_id: userId,
      event_id: eventId,
    });

    if (existing) {
      // Si existe, actualiza el progreso si es mayor
      if (progress > (existing.progress || 0)) {
        existing.progress = progress;
      }
      return existing.save();
    } else {
      // Crear nuevo
      const newRecord = new this.courseAttendeeModel({
        user_id: userId,
        event_id: eventId,
        progress: progress || 0,
      });
      return newRecord.save();
    }
  }

  async findAll(): Promise<CourseAttendee[]> {
    // Opcional: populate para traer datos del user o course
    return this.courseAttendeeModel
      .find()
      .populate('user_id')
      .populate('course_id')
      .exec();
  }

  async findById(id: string): Promise<CourseAttendee> {
    const record = await this.courseAttendeeModel
      .findById(id)
      .populate('user_id')
      .populate('course_id')
      .exec();
    if (!record) {
      throw new NotFoundException(`CourseAttendee con id ${id} no encontrado`);
    }
    return record;
  }

  async update(id: string, updateDto: any): Promise<CourseAttendee> {
    // updateDto podría ser { status: 'COMPLETED' } o similar
    const updated = await this.courseAttendeeModel
      .findByIdAndUpdate(id, updateDto, { new: true })
      .exec();
    if (!updated) {
      throw new NotFoundException(`CourseAttendee con id ${id} no encontrado`);
    }
    return updated;
  }

  async remove(id: string): Promise<CourseAttendee> {
    const deleted = await this.courseAttendeeModel.findByIdAndDelete(id).exec();
    if (!deleted) {
      throw new NotFoundException(`CourseAttendee con id ${id} no encontrado`);
    }
    return deleted;
  }
}
