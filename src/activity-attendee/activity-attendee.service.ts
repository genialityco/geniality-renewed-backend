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

    const userVals = this.idVariants(userId);
    const eventVals = this.idVariants(eventId);

    // Driver nativo para no castear: la data mezcla string/ObjectId.
    const activities = await this.activityModel.collection
      .find({ event_id: { $in: eventVals } }, { projection: { _id: 1 } })
      .toArray();

    const totalActivities = activities.length;
    if (totalActivities === 0) return;

    const activityVals = activities.flatMap((a: any) => this.idVariants(a._id));

    const completedCount = await this.activityAttendeeModel.collection.countDocuments(
      {
        user_id: { $in: userVals },
        activity_id: { $in: activityVals },
        progress: 100,
      },
    );

    const courseProgress = Math.round((completedCount / totalActivities) * 100);

    // Upsert type-agnostic: matchea el registro existente sin importar cómo se
    // guardaron los ids; solo inserta si de verdad no existe (evita duplicados
    // por diferencia de tipo user_id string vs ObjectId).
    await this.courseAttendeeModel.collection.updateOne(
      { user_id: { $in: userVals }, event_id: { $in: eventVals } },
      {
        $set: { progress: courseProgress },
        $currentDate: { updatedAt: true },
        $setOnInsert: {
          user_id: String(userId),
          event_id: eventId,
          status: 'ACTIVE',
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
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
   * Devuelve las dos representaciones posibles de un id (string y ObjectId).
   * La data histórica es inconsistente: `user_id` se guarda como string,
   * mientras `event_id`/`activity_id` pueden ser string u ObjectId. Consultar
   * con ambas formas evita que el casteo de Mongoose deje registros por fuera.
   */
  private idVariants(id: string | Types.ObjectId): any[] {
    const raw = String(id);
    const out: any[] = [raw];
    if (Types.ObjectId.isValid(raw) && String(new Types.ObjectId(raw)) === raw) {
      out.push(new Types.ObjectId(raw));
    }
    return out;
  }

  /**
   * Obtiene todos los activityAttendees de un usuario para un evento.
   *
   * Se consulta con el driver nativo (sin casteo de Mongoose) porque la data es
   * heterogénea:
   *  - `user_id` está guardado como string en todos los registros.
   *  - `event_id` puede ser ObjectId, string o faltar por completo en registros
   *    antiguos (creados antes de que existiera ese campo).
   *
   * Para no perder actividades ya vistas, además de filtrar por `event_id` se
   * recuperan los registros sin `event_id` haciendo match por `activity_id`
   * contra las actividades que pertenecen al evento.
   */
  async findByUserIdAndEventId(
    userId: string,
    eventId: string,
  ): Promise<ActivityAttendee[]> {
    const userVals = this.idVariants(userId);
    const eventVals = this.idVariants(eventId);

    // Actividades del evento (ambas representaciones de _id) para recuperar
    // registros antiguos que no tienen event_id.
    const activities = await this.activityModel.collection
      .find({ event_id: { $in: eventVals } }, { projection: { _id: 1 } })
      .toArray();
    const activityVals = activities.flatMap((a: any) => this.idVariants(a._id));

    const or: any[] = [{ event_id: { $in: eventVals } }];
    if (activityVals.length) or.push({ activity_id: { $in: activityVals } });

    const docs = await this.activityAttendeeModel.collection
      .find({ user_id: { $in: userVals }, $or: or })
      .toArray();

    return docs as unknown as ActivityAttendee[];
  }
}
