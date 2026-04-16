import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ActivityAttendee } from './schemas/activity-attendee.schema';
import { Activity } from '../activities/schemas/activity.schema';
import { CourseAttendee } from '../course-attendee/schemas/course-attendee.schema';

@Injectable()
export class ActivityAttendeeService {
  constructor(
    @InjectModel(ActivityAttendee.name)
    private readonly activityAttendeeModel: Model<ActivityAttendee>,
    @InjectModel(Activity.name)
    private readonly activityModel: Model<Activity>,
    @InjectModel(CourseAttendee.name)
    private readonly courseAttendeeModel: Model<CourseAttendee>,
  ) {}

  private async syncCourseProgress(
    userId: string,
    activityId: string,
  ): Promise<void> {
    const activity = await this.activityModel
      .findById(activityId)
      .select('event_id')
      .exec();

    if (!activity?.event_id) return;

    const eventId = activity.event_id;

    const activities = await this.activityModel
      .find({ event_id: eventId })
      .select('_id')
      .lean()
      .exec();

    const totalActivities = activities.length;
    if (totalActivities === 0) return;

    const activityIds = activities.map((a: any) => a._id);

    const completedCount = await this.activityAttendeeModel.countDocuments({
      user_id: userId,
      activity_id: { $in: activityIds },
      progress: 100,
    });

    const courseProgress = Math.round((completedCount / totalActivities) * 100);

    await this.courseAttendeeModel
      .findOneAndUpdate(
        {
          user_id: userId,
          event_id: eventId,
        },
        {
          $setOnInsert: {
            user_id: userId,
            event_id: eventId,
            status: 'ACTIVE',
          },
          $set: {
            progress: courseProgress,
          },
        },
        {
          upsert: true,
          new: true,
        },
      )
      .exec();
  }

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
    const normalizedProgress = Math.max(0, Math.min(100, Math.round(progress || 0)));

    // Obtener event_id de la activity
    const activity = await this.activityModel
      .findById(activityId)
      .select('event_id')
      .exec();

    if (!activity?.event_id) {
      throw new Error(`Activity con id ${activityId} no encontrada o sin event_id`);
    }

    const attendee = await this.activityAttendeeModel
      .findOneAndUpdate(
        {
          user_id: userId,
          activity_id: activityId,
        },
        {
          $setOnInsert: {
            user_id: userId,
            activity_id: activityId,
            event_id: activity.event_id,
          },
          $max: {
            progress: normalizedProgress,
          },
        },
        {
          upsert: true,
          new: true,
        },
      )
      .exec();

    await this.syncCourseProgress(userId, activityId);

    return attendee;
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

  /**
   * Obtiene todos los activityAttendees de un usuario para un evento específico
   * Utilizando directamente el event_id guardado en activityAttendee
   */
  async findByUserIdAndEventId(
    userId: string,
    eventId: string,
  ): Promise<ActivityAttendee[]> {
    return this.activityAttendeeModel
      .find({
        user_id: userId,
        event_id: eventId,
      })
      .populate('activity_id')
      .exec();
  }
}
