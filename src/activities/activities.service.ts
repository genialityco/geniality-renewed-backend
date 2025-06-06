import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Activity } from './schemas/activity.schema';

@Injectable()
export class ActivitiesService {
  constructor(
    @InjectModel(Activity.name) private readonly activityModel: Model<Activity>,
  ) {}

  // Crear una nueva actividad
  async create(activityData: Partial<Activity>): Promise<Activity> {
    const newActivity = new this.activityModel(activityData);
    return newActivity.save();
  }

  // Obtener todas las actividades
  async findAll(): Promise<Activity[]> {
    return this.activityModel.find().exec();
  }

  // Obtener actividad por ID
  async findOne(id: string): Promise<Activity> {
    const activity = await this.activityModel.findById(id).exec();
    if (!activity) {
      throw new NotFoundException(`Actividad con ID ${id} no encontrada`);
    }
    return activity;
  }

  // Actualizar actividad (parcial o total)
  async update(id: string, activityData: Partial<Activity>): Promise<Activity> {
    const updatedActivity = await this.activityModel.findByIdAndUpdate(
      id,
      activityData,
      { new: true },
    );
    if (!updatedActivity) {
      throw new NotFoundException(`Actividad con ID ${id} no encontrada`);
    }
    return updatedActivity;
  }

  // Eliminar una actividad
  async delete(id: string): Promise<Activity> {
    const deletedActivity = await this.activityModel
      .findByIdAndDelete(id)
      .exec();
    if (!deletedActivity) {
      throw new NotFoundException(`Actividad con ID ${id} no encontrada`);
    }
    return deletedActivity;
  }

  // Obtener actividades de un evento
  async findByEventId(event_id: string): Promise<Activity[]> {
    return this.activityModel.find({ event_id }).exec();
  }

  // Actualizar el progreso de video (campo video_progress)
  async updateVideoProgress(id: string, progress: number): Promise<Activity> {
    if (progress < 0 || progress > 100) {
      throw new BadRequestException('El progreso debe estar entre 0 y 100.');
    }

    const activity = await this.activityModel.findByIdAndUpdate(
      id,
      { video_progress: progress },
      { new: true },
    );

    if (!activity) {
      throw new NotFoundException(`Actividad con ID ${id} no encontrada`);
    }

    return activity;
  }

  // Filtrar por organización (si la actividad guarda la referencia organization_id)
  async findByOrganization(organizationId?: string): Promise<Activity[]> {
    const filter = organizationId
      ? { organization_id: new Types.ObjectId(organizationId) }
      : { organization_id: null };

    return this.activityModel
      .find(filter)
      .populate('organization_id')
      .populate('event_id')
      .exec();
  }

  // Actualizar disponibilidad de transcripción
  async updateTranscriptAvailable(activityId: string, available: boolean) {
    return this.update(activityId, { transcript_available: available });
  }
}
