// course-attendee.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CourseAttendee } from './schemas/course-attendee.schema';
import { Activity } from '../activities/schemas/activity.schema';
import { Event } from '../events/schemas/event.schema';
import { ActivityAttendeeService } from '../activity-attendee/activity-attendee.service';

@Injectable()
export class CourseAttendeeService {
  constructor(
    @InjectModel(CourseAttendee.name)
    private readonly courseAttendeeModel: Model<CourseAttendee>,
    @InjectModel(Activity.name)
    private readonly activityModel: Model<Activity>,
    @InjectModel(Event.name)
    private readonly eventModel: Model<Event>,
    private readonly activityAttendeeService: ActivityAttendeeService,
  ) {}

  /**
   * Devuelve las dos representaciones posibles de un id (string y ObjectId).
   * La data histórica es heterogénea: `user_id`/`event_id` pueden estar
   * guardados como string o como ObjectId. Consultar con ambas formas evita
   * que el casteo de Mongoose deje registros por fuera.
   */
  private idVariants(id: string | Types.ObjectId): any[] {
    const raw = String(id);
    const out: any[] = [raw];
    if (Types.ObjectId.isValid(raw) && String(new Types.ObjectId(raw)) === raw) {
      out.push(new Types.ObjectId(raw));
    }
    return out;
  }

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
    const userVals = this.idVariants(userId);
    const eventVals = this.idVariants(eventId);

    // Upsert atómico y type-agnostic (driver nativo, sin casteo). El match por
    // $in encuentra el registro existente sin importar cómo se guardaron los
    // ids; solo inserta si no existe, evitando duplicados por diferencia de
    // tipo (string vs ObjectId). $max nunca baja el progreso.
    await this.courseAttendeeModel.collection.updateOne(
      { user_id: { $in: userVals }, event_id: { $in: eventVals } },
      {
        $max: { progress: Math.round(progress || 0) },
        $currentDate: { updatedAt: true },
        $setOnInsert: {
          user_id: String(userId),
          event_id: eventVals.length > 1 ? eventVals[1] : String(eventId),
          status: 'ACTIVE',
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );

    const doc = await this.courseAttendeeModel.collection.findOne({
      user_id: { $in: userVals },
      event_id: { $in: eventVals },
    });
    return doc as unknown as CourseAttendee;
  }

  async findAll(): Promise<CourseAttendee[]> {
    // Opcional: populate para traer datos del user o course
    return this.courseAttendeeModel
      .find()
      .populate('user_id')
      .populate('event_id')
      .exec();
  }

  async findById(id: string): Promise<CourseAttendee> {
    const record = await this.courseAttendeeModel
      .findById(id)
      .populate('user_id')
      .populate('event_id')
      .exec();
    if (!record) {
      throw new NotFoundException(`CourseAttendee con id ${id} no encontrado`);
    }
    return record;
  }

  async findByUserId(userId: string): Promise<CourseAttendee[]> {
    // Match type-agnostic por _id (driver nativo) y luego populate con Mongoose.
    const raw = await this.courseAttendeeModel.collection
      .find({ user_id: { $in: this.idVariants(userId) } }, { projection: { _id: 1 } })
      .toArray();
    const ids = raw.map((r) => r._id);
    if (!ids.length) return [];
    return this.courseAttendeeModel
      .find({ _id: { $in: ids } })
      .populate('user_id')
      .populate('event_id')
      .exec();
  }

  // "Mis Cursos" se ve siempre dentro del contexto de una organización
  // (URL /organization/:organizationId/profile), así que la lista de
  // cursos debe quedar acotada a esa organización — no mezclar cursos
  // de otras organizaciones en las que el usuario también esté inscrito.
  async findByUserIdAndOrganization(
    userId: string,
    organizationId: string,
  ): Promise<CourseAttendee[]> {
    // organizer_id (y event_id/user_id en course-attendees) puede estar
    // guardado como string u ObjectId según cómo se insertó el registro
    // (datos heredados no siempre castean al tipo declarado en el schema).
    // Se usa el driver nativo para no castear y contemplar ambas formas; luego
    // se cargan con Mongoose por _id para conservar el populate.
    const orgEvents = await this.eventModel.collection
      .find(
        { organizer_id: { $in: this.idVariants(organizationId) } },
        { projection: { _id: 1 } },
      )
      .toArray();
    const eventVals = orgEvents.flatMap((e: any) => this.idVariants(e._id));
    if (!eventVals.length) return [];

    const raw = await this.courseAttendeeModel.collection
      .find(
        {
          user_id: { $in: this.idVariants(userId) },
          event_id: { $in: eventVals },
        },
        { projection: { _id: 1 } },
      )
      .toArray();
    const ids = raw.map((r) => r._id);
    if (!ids.length) return [];

    return this.courseAttendeeModel
      .find({ _id: { $in: ids } })
      .populate('user_id')
      .populate('event_id')
      .exec();
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

  /**
   * Calcula el progreso general de un curso para un usuario específico
   * @param userId ID del usuario
   * @param eventId ID del evento/curso
   * @returns Porcentaje de progreso (0-100)
   */
  async calculateProgressForCourse(
    userId: string,
    eventId: string,
  ): Promise<number> {
    // 1. Obtener todas las actividades del evento
    const activities = await this.activityModel
      .find({ event_id: eventId })
      .exec();

    if (activities.length === 0) {
      return 0;
    }

    // 2. Obtener el progreso del usuario para este evento
    const attendees = await this.activityAttendeeService.findByUserIdAndEventId(
      userId,
      eventId,
    );

    // 3. Contar cuántas actividades están completadas (progreso === 100)
    const completedCount = attendees.filter(
      (att) => att.progress === 100,
    ).length;

    // 4. Calcular porcentaje
    return Math.round((completedCount / activities.length) * 100);
  }
}
