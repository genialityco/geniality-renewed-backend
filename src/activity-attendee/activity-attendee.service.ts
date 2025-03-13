import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ActivityAttendee } from './schemas/activity-attendee.schema';

@Injectable()
export class ActivityAttendeeService {
  constructor(
    @InjectModel(ActivityAttendee.name)
    private readonly activityAttendeeModel: Model<ActivityAttendee>,
  ) {}

  async create(createDto: any): Promise<ActivityAttendee> {
    // { user_id, activity_id, progress? }
    const record = new this.activityAttendeeModel(createDto);
    return record.save();
  }

  async createOrUpdate(
    userId: string,
    activityId: string,
    progress: number,
  ): Promise<ActivityAttendee> {
    const existing = await this.activityAttendeeModel.findOne({
      user_id: userId,
      activity_id: activityId,
    });

    if (existing) {
      // Si existe, actualiza el progreso si es mayor
      if (progress > (existing.progress || 0)) {
        existing.progress = progress;
      }
      return existing.save();
    } else {
      // Crear nuevo
      const newRecord = new this.activityAttendeeModel({
        user_id: userId,
        activity_id: activityId,
        progress: progress || 0,
      });
      return newRecord.save();
    }
  }

  async findAll(): Promise<ActivityAttendee[]> {
    return this.activityAttendeeModel
      .find()
      .populate('user_id')
      .populate('activity_id')
      .exec();
  }

  async findById(id: string): Promise<ActivityAttendee> {
    const record = await this.activityAttendeeModel
      .findById(id)
      .populate('user_id')
      .populate('activity_id')
      .exec();
    if (!record) {
      throw new NotFoundException(
        `ActivityAttendee con id ${id} no encontrado`,
      );
    }
    return record;
  }

  async update(id: string, updateDto: any): Promise<ActivityAttendee> {
    const updated = await this.activityAttendeeModel
      .findByIdAndUpdate(id, updateDto, { new: true })
      .exec();
    if (!updated) {
      throw new NotFoundException(
        `ActivityAttendee con id ${id} no encontrado`,
      );
    }
    return updated;
  }

  async remove(id: string): Promise<ActivityAttendee> {
    const deleted = await this.activityAttendeeModel
      .findByIdAndDelete(id)
      .exec();
    if (!deleted) {
      throw new NotFoundException(
        `ActivityAttendee con id ${id} no encontrado`,
      );
    }
    return deleted;
  }
}
