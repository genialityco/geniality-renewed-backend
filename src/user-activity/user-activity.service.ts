import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UserActivity } from './schemas/user-activity.schema';

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

    console.log(
      `🚀 startSession called for userId: ${userId}, org: ${organizationId}`,
    );

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
      console.warn(
        `⚠️ WARNING: Found ${finalCount} records for user ${userId}, org ${organizationId}`,
      );
      // Listar IDs
      const all = await this.userActivityModel.find({
        user_id: userId,
        organization_id: organizationId,
      });
      console.log(
        '  Record IDs:',
        all.map((r) => r._id),
      );
    }

    return activity;
  }

  /**
   * Finaliza la sesión del usuario
   */
  async endSession(
    userId: string,
    organizationId: string,
  ): Promise<UserActivity> {
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
    activity.session_duration_ms =
      now.getTime() - activity.session_start.getTime();
    activity.is_active = false;
    activity.last_updated = now;

    return activity.save();
  }

  /**
   * Tope de cada envío de tiempo. El front sincroniza cada 30 s, así que un
   * delta mayor solo puede venir de un cliente defectuoso (o de un reloj que
   * saltó) y no debe inflar las métricas.
   */
  private static readonly MAX_TIME_DELTA_MS = 15 * 60 * 1000;

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
  ): Promise<void> {
    await this.addTime(userId, organizationId, {
      arrayField: 'courses',
      totalField: 'total_courses_time_ms',
      match: { course_id: courseId, event_id: eventId },
      name: courseName ? { course_name: courseName } : {},
      timeDeltaMs,
    });
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
  ): Promise<void> {
    await this.addTime(userId, organizationId, {
      arrayField: 'activities',
      totalField: 'total_activities_time_ms',
      match: { activity_id: activityId, event_id: eventId },
      name: activityName ? { activity_name: activityName } : {},
      timeDeltaMs,
    });
  }

  /**
   * Suma tiempo a un curso o actividad del registro del usuario.
   *
   * - Se hace con updates atómicos ($inc / $push) y no con leer-sumar-guardar:
   *   el front envía curso y actividad casi a la vez (y puede haber varias
   *   pestañas), y con save() un envío pisaba al otro perdiendo tiempo y
   *   duplicando entradas del arreglo.
   * - No exige `is_active`: cerrar o recargar CUALQUIER pestaña marca la
   *   sesión como terminada (beforeunload), y antes eso hacía que todo el
   *   tiempo de las demás pestañas se rechazara con 404 y se perdiera.
   */
  private async addTime(
    userId: string,
    organizationId: string,
    opts: {
      arrayField: 'courses' | 'activities';
      totalField: 'total_courses_time_ms' | 'total_activities_time_ms';
      match: Record<string, string>;
      name: Record<string, string>;
      timeDeltaMs: number;
    },
  ): Promise<void> {
    const { arrayField, totalField, match, name } = opts;
    const delta = Math.round(
      Math.min(
        Math.max(opts.timeDeltaMs || 0, 0),
        UserActivityService.MAX_TIME_DELTA_MS,
      ),
    );
    const now = new Date();
    const owner = { user_id: userId, organization_id: organizationId };
    const elemMatch = { [arrayField]: { $elemMatch: match } };

    const nameSet = Object.fromEntries(
      Object.entries(name).map(([k, v]) => [`${arrayField}.$.${k}`, v]),
    );
    const incExisting = () =>
      this.userActivityModel.updateOne(
        { ...owner, ...elemMatch },
        {
          $inc: {
            [`${arrayField}.$.time_spent_ms`]: delta,
            [totalField]: delta,
          },
          $set: {
            [`${arrayField}.$.last_updated`]: now,
            last_updated: now,
            ...nameSet,
          },
        },
      );

    if ((await incExisting()).matchedCount > 0) return;

    // Primera vez en este curso/actividad. El filtro con $not evita que dos
    // envíos simultáneos agreguen la misma entrada dos veces.
    const pushed = await this.userActivityModel.updateOne(
      { ...owner, [arrayField]: { $not: { $elemMatch: match } } },
      {
        $push: {
          [arrayField]: {
            ...match,
            ...name,
            time_spent_ms: delta,
            last_updated: now,
          },
        },
        $inc: { [totalField]: delta },
        $set: { last_updated: now },
      },
    );
    if (pushed.matchedCount > 0) return;

    // Otro envío la agregó entre medio: ahora sí existe.
    if ((await incExisting()).matchedCount > 0) return;

    throw new NotFoundException(
      `No hay registro de actividad para el usuario ${userId}`,
    );
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
    consolidated.total_activities_time_ms = Array.from(
      allActivities.values(),
    ).reduce((sum, a) => sum + a.time_spent_ms, 0);

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
    return this.userActivityModel
      .findOne({
        user_id: userId,
        organization_id: organizationId,
      })
      .sort({ createdAt: -1 });
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

  /**
   * Obtiene los registros cuya última actividad cayó dentro de la ventana
   * [ahora - (daysAgo + windowDays), ahora - daysAgo). Sirve para detectar
   * usuarios que cruzaron el umbral de inactividad sin reenviarles el
   * recordatorio en cada corrida del cron mientras sigan inactivos.
   */
  async findInactiveWindow(
    daysAgo: number,
    windowDays: number = 1,
  ): Promise<UserActivity[]> {
    const to = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const from = new Date(
      Date.now() - (daysAgo + windowDays) * 24 * 60 * 60 * 1000,
    );
    return this.userActivityModel.find({
      last_updated: { $gte: from, $lt: to },
    });
  }

  /**
   * Obtiene el registro de actividad más reciente de un usuario sin
   * necesidad de conocer de antemano la organización. Lo usa el endpoint
   * de prueba de plantillas de WhatsApp para armar el mensaje con datos
   * reales a partir de solo un userId.
   */
  async findLatestByUserId(userId: string): Promise<UserActivity | null> {
    return this.userActivityModel
      .findOne({ user_id: userId })
      .sort({ last_updated: -1 });
  }

  /**
   * Obtiene los registros con actividad en los últimos N días.
   * Lo usa el reporte semanal para considerar solo usuarios activos.
   */
  async findActiveSince(days: number): Promise<UserActivity[]> {
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return this.userActivityModel.find({
      last_updated: { $gte: from },
    });
  }
}
