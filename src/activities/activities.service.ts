import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Activity } from './schemas/activity.schema';

@Injectable()
export class ActivitiesService {
  constructor(
    @InjectModel(Activity.name) private readonly activityModel: Model<Activity>,
  ) {}

  async create(activity: Activity): Promise<Activity> {
    const newActivity = new this.activityModel(activity);
    return newActivity.save();
  }

  async findAll(): Promise<Activity[]> {
    return this.activityModel.find().exec();
  }

  async findOne(id: string): Promise<Activity> {
    return this.activityModel.findById(id).exec();
  }

  async update(id: string, activity: Partial<Activity>): Promise<Activity> {
    return this.activityModel
      .findByIdAndUpdate(id, activity, { new: true })
      .exec();
  }

  async delete(id: string): Promise<Activity> {
    return this.activityModel.findByIdAndDelete(id).exec();
  }

  async findByEventId(event_id: string): Promise<Activity[]> {
    return this.activityModel.find({ event_id }).exec();
  }

  async updateVideoProgress(id: string, progress: number): Promise<Activity> {
    if (progress < 0 || progress > 100) {
      throw new Error('El progreso debe estar entre 0 y 100.');
    }

    const activity = await this.activityModel
      .findByIdAndUpdate(id, { video_progress: progress }, { new: true })
      .exec();

    if (!activity) {
      throw new NotFoundException(`Actividad con ID ${id} no encontrada`);
    }

    return activity;
  }
}
