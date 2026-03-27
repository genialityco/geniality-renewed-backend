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
    const data = { ...activityData };
    if (data.event_id && typeof data.event_id === 'string') {
      try {
        data.event_id = new Types.ObjectId(data.event_id as unknown as string) as any;
      } catch (_) {}
    }
    const newActivity = new this.activityModel(data);
    return newActivity.save();
  }

  // Obtener todas las actividades
  async findAll(): Promise<Activity[]> {
    return this.activityModel.find().exec();
  }

  // Obtener actividad por ID
  async findOne(id: string): Promise<Activity> {
    const activity = await this.activityModel
      .findById(id)
      .populate('event_id')
      .exec();
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

  // Obtener actividades de un evento (soporta event_id guardado como string o como ObjectId)
  async findByEventId(event_id: string): Promise<Activity[]> {
    const conditions: any[] = [{ event_id }];
    try {
      conditions.push({ event_id: new Types.ObjectId(event_id) });
    } catch (_) {}
    return this.activityModel.find({ $or: conditions }).exec();
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

  // Filtrar por organización: por organization_id directo O por evento cuyo organizer_id coincida
  async findByOrganization(
    organizationId?: string,
    page = 1,
    limit = 20,
  ): Promise<{
    results: Activity[];
    total: number;
    page: number;
    limit: number;
  }> {
    if (!organizationId) {
      const skip = (page - 1) * limit;
      const [results, total] = await Promise.all([
        this.activityModel
          .find({ organization_id: null })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .populate('event_id')
          .exec(),
        this.activityModel.countDocuments({ organization_id: null }),
      ]);
      return { results, total, page, limit };
    }

    const orgObjectId = new Types.ObjectId(organizationId);
    const skip = (page - 1) * limit;

    // Busca actividades cuyo organization_id coincida directamente,
    // O cuyo event_id pertenezca a un evento con organizer_id === organizationId
    const matchStage = {
      $match: {
        $or: [
          { organization_id: orgObjectId },
          { event_id: { $exists: true, $ne: null } },
        ],
      },
    };

    const lookupStage = {
      $lookup: {
        from: 'events',
        localField: 'event_id',
        foreignField: '_id',
        as: '_event',
      },
    };

    const filterStage = {
      $match: {
        $or: [
          { organization_id: orgObjectId },
          { '_event.organizer_id': orgObjectId },
        ],
      },
    };

    const [countResult, results] = await Promise.all([
      this.activityModel
        .aggregate([matchStage, lookupStage, filterStage, { $count: 'total' }])
        .exec(),
      this.activityModel
        .aggregate([
          matchStage,
          lookupStage,
          filterStage,
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: limit },
        ])
        .exec(),
    ]);

    const total = countResult[0]?.total ?? 0;

    // Populate event_id manualmente tras el aggregate
    const populated = await this.activityModel.populate(results, {
      path: 'event_id',
    });

    return { results: populated as any, total, page, limit };
  }

  // Actualizar disponibilidad de transcripción
  async updateTranscriptAvailable(activityId: string, available: boolean) {
    return this.update(activityId, { transcript_available: available });
  }
}
