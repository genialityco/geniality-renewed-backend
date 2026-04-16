import { Injectable, NotFoundException, OnModuleInit, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UserActivity, CourseTime, ActivityTime } from './schemas/user-activity.schema';

@Injectable()
export class UserActivityService implements OnModuleInit {
  constructor(
    @InjectModel(UserActivity.name)
    private userActivityModel: Model<UserActivity>,
  ) {}

  /**
   * Inicializar módulo y crear índices
   */
  async onModuleInit() {
    try {
      console.log('🔧 Recreando índices del modelo UserActivity...');
      await this.userActivityModel.syncIndexes();
      console.log('✅ Índices recreados correctamente');
    } catch (error) {
      console.error('❌ Error recreando índices:', error);
    }
  }

  /**
   * Inicia una nueva sesión para el usuario
   * Usa upsert para evitar race conditions si se llama múltiples veces
   */
  async startSession(
    userId: string,
    firebaseUid: string,
    organizationId: string,
  ): Promise<UserActivity> {
    const now = new Date();

    console.log(`🚀 startSession called for userId: ${userId}, org: ${organizationId}`);

    // Primero, verificar cuántos registros ya existen
    const existingCount = await this.userActivityModel.countDocuments({
      user_id: userId,
      organization_id: organizationId,
    });
    console.log(`📊 Existing records before upsert: ${existingCount}`);

    // Usar findOneAndUpdate con upsert para evitar race conditions
    // Si existe, actualiza; si no existe, crea uno nuevo
    const activity = await this.userActivityModel.findOneAndUpdate(
      {
        user_id: userId,
        organization_id: organizationId,
      },
      {
        $set: {
          session_start: now,
          session_end: null,
          is_active: true,
          last_updated: now,
        },
        $setOnInsert: {
          firebase_uid: firebaseUid,
          session_duration_ms: 0,
          courses: [],
          activities: [],
          total_courses_time_ms: 0,
          total_activities_time_ms: 0,
        },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
      },
    );

    console.log(`✅ Record after upsert: ${activity._id}`);

    // Verificar el total después
    const finalCount = await this.userActivityModel.countDocuments({
      user_id: userId,
      organization_id: organizationId,
    });
    console.log(`📊 Total records after upsert: ${finalCount}`);

    if (finalCount > 1) {
      console.warn(`⚠️ WARNING: Found ${finalCount} records for user ${userId}, org ${organizationId}`);
      // Listar IDs
      const all = await this.userActivityModel.find({
        user_id: userId,
        organization_id: organizationId,
      });
      console.log('  Record IDs:', all.map(r => r._id));
    }

    return activity;
  }

  /**
   * Finaliza la sesión del usuario
   */
  async endSession(userId: string, organizationId: string): Promise<UserActivity> {
    const activity = await this.userActivityModel.findOne({
      user_id: userId,
      organization_id: organizationId,
    });

    if (!activity) {
      throw new NotFoundException(
        `No hay registro de actividad para el usuario ${userId}`,
      );
    }

    const now = new Date();
    activity.session_end = now;
    activity.session_duration_ms = now.getTime() - activity.session_start.getTime();
    activity.is_active = false;
    activity.last_updated = now;

    return activity.save();
  }

  /**
   * Actualiza el tiempo dedicado a un curso
   */
  async updateCourseTime(
    userId: string,
    organizationId: string,
    courseId: string,
    eventId: string,
    timeDeltaMs: number,
    courseName?: string,
  ): Promise<UserActivity> {
    let activity = await this.userActivityModel.findOne({
      user_id: userId,
      organization_id: organizationId,
      is_active: true,
    });

    if (!activity) {
      throw new NotFoundException(
        `No hay sesión activa para el usuario ${userId}`,
      );
    }

    // Buscar si el curso ya existe en el registro
    const courseIndex = activity.courses.findIndex(
      (c) => c.course_id === courseId && c.event_id === eventId,
    );

    const now = new Date();

    if (courseIndex >= 0) {
      // Actualizar tiempo existente
      activity.courses[courseIndex].time_spent_ms += timeDeltaMs;
      activity.courses[courseIndex].last_updated = now;
      // Actualizar nombre si se proporciona
      if (courseName) {
        activity.courses[courseIndex].course_name = courseName;
      }
    } else {
      // Agregar nuevo curso
      activity.courses.push({
        course_id: courseId,
        event_id: eventId,
        course_name: courseName,
        time_spent_ms: Math.max(0, timeDeltaMs),
        last_updated: now,
      });
    }

    // Recalcular total de cursos
    activity.total_courses_time_ms = activity.courses.reduce(
      (sum, c) => sum + c.time_spent_ms,
      0,
    );

    activity.last_updated = now;
    return activity.save();
  }

  /**
   * Actualiza el tiempo dedicado a una actividad
   */
  async updateActivityTime(
    userId: string,
    organizationId: string,
    activityId: string,
    eventId: string,
    timeDeltaMs: number,
    activityName?: string,
  ): Promise<UserActivity> {
    let activity = await this.userActivityModel.findOne({
      user_id: userId,
      organization_id: organizationId,
      is_active: true,
    });

    if (!activity) {
      throw new NotFoundException(
        `No hay sesión activa para el usuario ${userId}`,
      );
    }

    // Buscar si la actividad ya existe en el registro
    const activityIndex = activity.activities.findIndex(
      (a) => a.activity_id === activityId && a.event_id === eventId,
    );

    const now = new Date();

    if (activityIndex >= 0) {
      // Actualizar tiempo existente
      activity.activities[activityIndex].time_spent_ms += timeDeltaMs;
      activity.activities[activityIndex].last_updated = now;
      // Actualizar nombre si se proporciona
      if (activityName) {
        activity.activities[activityIndex].activity_name = activityName;
      }
    } else {
      // Agregar nueva actividad
      activity.activities.push({
        activity_id: activityId,
        event_id: eventId,
        activity_name: activityName,
        time_spent_ms: Math.max(0, timeDeltaMs),
        last_updated: now,
      });
    }

    // Recalcular total de actividades
    activity.total_activities_time_ms = activity.activities.reduce(
      (sum, a) => sum + a.time_spent_ms,
      0,
    );

    activity.last_updated = now;
    return activity.save();
  }

  /**
   * Consolida múltiples registros de actividad en uno solo
   * Suma todos los tiempos, cursos y actividades de registros duplicados
   */
  private consolidateActivityRecords(records: UserActivity[]): UserActivity {
    if (records.length === 0) {
      throw new NotFoundException('No hay registros de actividad');
    }

    if (records.length === 1) {
      return records[0];
    }

    // Consolidar datos
    const consolidated = records[0];
    const allCourses = new Map<string, any>(); // Key: course_id_event_id
    const allActivities = new Map<string, any>(); // Key: activity_id_event_id

    // Agregar cursos de todos los registros
    for (const record of records) {
      for (const course of record.courses || []) {
        const key = `${course.course_id}_${course.event_id}`;
        if (allCourses.has(key)) {
          allCourses.get(key).time_spent_ms += course.time_spent_ms;
        } else {
          allCourses.set(key, { ...course });
        }
      }

      // Agregar actividades de todos los registros
      for (const activity of record.activities || []) {
        const key = `${activity.activity_id}_${activity.event_id}`;
        if (allActivities.has(key)) {
          allActivities.get(key).time_spent_ms += activity.time_spent_ms;
        } else {
          allActivities.set(key, { ...activity });
        }
      }
    }

    // Asignar datos consolidados
    consolidated.courses = Array.from(allCourses.values());
    consolidated.activities = Array.from(allActivities.values());
    consolidated.total_courses_time_ms = Array.from(allCourses.values()).reduce(
      (sum, c) => sum + c.time_spent_ms,
      0,
    );
    consolidated.total_activities_time_ms = Array.from(allActivities.values()).reduce(
      (sum, a) => sum + a.time_spent_ms,
      0,
    );

    return consolidated;
  }

  /**
   * Obtiene el registro de actividad actual del usuario
   * Devuelve el único registro que existe para ese usuario+organización
   * Si existen múltiples, los consolida en uno solo
   */
  async getActiveActivity(
    userId: string,
    organizationId: string,
  ): Promise<UserActivity> {
    const records = await this.userActivityModel.find({
      user_id: userId,
      organization_id: organizationId,
    });

    if (!records || records.length === 0) {
      throw new NotFoundException(
        `No hay registro de actividad para el usuario ${userId}`,
      );
    }

    // Si existen múltiples registros, consolidarlos
    return this.consolidateActivityRecords(records);
  }

  /**
   * Obtiene el último registro de actividad del usuario (activo o inactivo)
   */
  async getLastActivity(
    userId: string,
    organizationId: string,
  ): Promise<UserActivity | null> {
    return this.userActivityModel.findOne({
      user_id: userId,
      organization_id: organizationId,
    }).sort({ createdAt: -1 });
  }

  /**
   * Obtiene el histórico de actividad del usuario
   */
  async getUserActivityHistory(
    userId: string,
    organizationId: string,
    limit: number = 30,
  ): Promise<UserActivity[]> {
    return this.userActivityModel
      .find({
        user_id: userId,
        organization_id: organizationId,
      })
      .sort({ createdAt: -1 })
      .limit(limit);
  }
}
