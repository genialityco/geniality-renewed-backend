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

    if (data.organization_id) {
      try {
        if (typeof data.organization_id === 'string') {
          data.organization_id = new Types.ObjectId(data.organization_id) as any;
        } else {
          const rawOrgId = (data.organization_id as any)?._id;
          if (typeof rawOrgId === 'string') {
            data.organization_id = new Types.ObjectId(rawOrgId) as any;
          }
        }
      } catch (_) {}
    }

    const newActivity = new this.activityModel(data);
    const saved = await newActivity.save();
    await saved.populate('organization_id');
    return saved;
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

    // Agregar campo event_id poblado desde el resultado del lookup
    // Si no encuentra el evento en el lookup, mantiene el event_id original (string)
    const addFieldsStage = {
      $addFields: {
        event_id: {
          $cond: [
            { $gt: [{ $size: '$_event' }, 0] }, // Si _event tiene elementos
            { $arrayElemAt: ['$_event', 0] },    // Usar el evento poblado
            '$event_id'                           // Si no, mantener el event_id original
          ]
        },
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
          addFieldsStage,
          { $project: { _event: 0 } }, // Remover el campo temporal
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: limit },
        ])
        .exec(),
    ]);

    const total = countResult[0]?.total ?? 0;

    // Después del agregado, hacer populate en resultados que tengan event_id como string
    const populated = await Promise.all(
      results.map(async (result: any) => {
        if (typeof result.event_id === 'string') {
          // Si event_id es un string, poblarlo
          const doc = this.activityModel.hydrate(result);
          await doc.populate('event_id');
          return doc.toObject();
        }
        return result;
      })
    );

    return { results: populated as any, total, page, limit };
  }

  // Actualizar disponibilidad de transcripción
  async updateTranscriptAvailable(activityId: string, available: boolean) {
    return this.update(activityId, { transcript_available: available });
  }

  // Buscar actividades con jobs de transcripción pendientes (no marcadas como disponibles)
  async findActivitiesWithPendingJobs(): Promise<Activity[]> {
    return this.activityModel
      .find({
        transcription_job_id: { $exists: true, $ne: null },
        transcript_available: { $ne: true },
      })
      .exec();
  }
}
