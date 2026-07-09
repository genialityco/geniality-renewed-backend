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
    // findOne + save (leer, decidir, guardar) no es atómico: dos llamadas
    // concurrentes (p.ej. "inscribirse" al abrir el curso y "sincronizar
    // progreso" al ver un video) pueden ambas ver "no existe" y crear dos
    // documentos duplicados. findOneAndUpdate con upsert es atómico a nivel
    // de Mongo, y $max solo sube el progreso, nunca lo baja.
    return this.courseAttendeeModel
      .findOneAndUpdate(
        { user_id: userId, event_id: eventId },
        {
          $setOnInsert: { user_id: userId, event_id: eventId },
          $max: { progress: progress || 0 },
        },
        { upsert: true, new: true },
      )
      .exec();
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
    return this.courseAttendeeModel
      .find({ user_id: userId })
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
    // organizer_id (y event_id en course-attendees) puede estar guardado
    // como string u ObjectId según cómo se haya insertado el registro
    // (datos heredados no siempre castean al tipo declarado en el schema),
    // así que se contemplan ambas formas en cada cruce.
    const orgEvents = await this.eventModel
      .find({
        organizer_id: {
          $in: [organizationId, new Types.ObjectId(organizationId)],
        },
      })
      .select('_id')
      .lean()
      .exec();
    const eventIds = orgEvents.flatMap((e) => [e._id, e._id.toString()]);

    return this.courseAttendeeModel
      .find({ user_id: userId, event_id: { $in: eventIds } })
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
