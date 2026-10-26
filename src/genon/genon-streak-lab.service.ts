import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { GenOnProgram } from './schemas/genon-program.schema';
import { GenOnEnrollment } from './schemas/genon-enrollment.schema';
import { GenOnEngineService } from './genon-engine.service';
import { GenOnTriggersService } from './genon-triggers.service';
import { addDays } from './genon-streak';

const DAY_MS = 24 * 60 * 60 * 1000;
// Marca de lo que crea el laboratorio (para reconocerlo en la base)
const LAB_TAG = 'genon-streak-lab';

export type StreakLabAction = 'study' | 'next_day';

// Disparadores que dependen de la racha
const STREAK_KEYS = ['streak_milestone', 'streak_risk', 'streak_recovery'];

function idVariants(id: unknown): any[] {
  const raw = String(id);
  return Types.ObjectId.isValid(raw) && String(new Types.ObjectId(raw)) === raw
    ? [raw, new Types.ObjectId(raw)]
    : [raw];
}

/** Resta un día a un campo de fecha (si no es null) en un pipeline de actualización. */
const minusDay = (field: string) => ({
  $cond: [{ $eq: [{ $type: field }, 'date'] }, { $subtract: [field, DAY_MS] }, field],
});

/**
 * Laboratorio de rachas (Pruebas): la racha depende de días calendario, así
 * que para probarla sin esperar se "hace pasar el tiempo" sobre una persona
 * de una organización de prueba:
 * - study: hoy cuenta como día de estudio (vuelve a terminar su última
 *   actividad terminada; el avance del curso no cambia).
 * - next_day: corre un día hacia atrás todas sus fechas en el curso y en
 *   Gen.ON (avance, retos, días puenteados, inscripción y tiempo en el
 *   curso): para la racha, ayer pasa a ser antier y hoy es un día nuevo.
 * Los mensajes de racha se envían luego con los botones de cada disparador.
 */
@Injectable()
export class GenOnStreakLabService {
  constructor(
    @InjectModel(GenOnEnrollment.name)
    private readonly enrollmentModel: Model<GenOnEnrollment>,
    @InjectConnection() private readonly connection: Connection,
    private readonly engine: GenOnEngineService,
    private readonly triggers: GenOnTriggersService,
  ) {}

  private col(name: string) {
    return this.connection.collection(name);
  }

  async apply(
    program: GenOnProgram,
    userId: string,
    eventId: string,
    action: StreakLabAction,
  ) {
    const now = new Date();
    const { course, stats } = await this.engine.loadForUser(program, userId, eventId, now);
    await this.requireTestOrganizations([course.organizationId]);
    const e = await this.enrollmentModel
      .findOne({ program_id: String(program._id), event_id: eventId, user_id: userId, test: false })
      .exec();
    if (!e) {
      throw new BadRequestException('La persona aún no está segmentada en el programa.');
    }

    if (action === 'study') {
      if (!(await this.studyToday(userId, eventId, stats.completedAt.get(userId), now))) {
        throw new BadRequestException(
          'Para tener racha la persona debe haber terminado al menos una actividad del curso.',
        );
      }
    } else {
      await this.shiftDay(e, userId, eventId, course.activities.map((a) => a.id));
    }
    return this.triggers.simulateForUser(program, userId, eventId);
  }

  /**
   * Lo mismo para todos los inscritos del programa (junto a "Enviar ya").
   * Solo si todas sus organizaciones son de prueba. Tras pasar el día se
   * segmenta a todos: el día nuevo cuenta también para los flujos (el toque
   * del día 3 llega un día antes, quien no estudia se acerca a inactivos).
   * Los mensajes salen luego con "Enviar ya".
   */
  async applyAll(program: GenOnProgram, action: StreakLabAction) {
    const now = new Date();
    await this.requireTestOrganizations(program.organization_ids || []);
    const enrollments = await this.enrollmentModel
      .find({ program_id: String(program._id), test: false, exited: false })
      .exec();
    const ids = [...new Set(enrollments.map((e) => e.user_id))].filter((id) =>
      Types.ObjectId.isValid(id),
    );
    const users = await this.col('users')
      .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } }, { projection: { names: 1 } })
      .toArray();
    const names = new Map(users.map((u: any) => [String(u._id), String(u.names || '')]));

    const results: { user_id: string; name: string; ok: boolean; reason: string | null }[] = [];
    for (const eventId of [...new Set(enrollments.map((e) => e.event_id))]) {
      const cache = await this.engine.loadCourseCache(program, eventId, now);
      for (const e of enrollments.filter((x) => x.event_id === eventId)) {
        const name = names.get(e.user_id) || e.user_id;
        if (!cache) {
          results.push({ user_id: e.user_id, name, ok: false, reason: 'curso no encontrado' });
          continue;
        }
        if (action === 'study') {
          const ok = await this.studyToday(e.user_id, eventId, cache.stats.completedAt.get(e.user_id), now);
          results.push({
            user_id: e.user_id,
            name,
            ok,
            reason: ok ? null : 'no ha terminado ninguna actividad',
          });
        } else {
          await this.shiftDay(e, e.user_id, eventId, cache.course.activities.map((a) => a.id));
          results.push({ user_id: e.user_id, name, ok: true, reason: null });
        }
      }
    }
    if (action === 'next_day') await this.engine.segment(program, now);
    return { action, results };
  }

  /** Solo organizaciones de prueba: el laboratorio cambia fechas de estudio. */
  private async requireTestOrganizations(organizationIds: string[]) {
    const ids = organizationIds.filter((id) => Types.ObjectId.isValid(id));
    const marked = ids.length
      ? await this.col('organizations').countDocuments({
          _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
          seed_tag: { $exists: true, $ne: null },
        })
      : 0;
    if (!organizationIds.length || marked !== organizationIds.length) {
      throw new BadRequestException(
        'El laboratorio de rachas solo funciona en organizaciones de prueba: cambia las fechas de estudio de las personas.',
      );
    }
  }

  /**
   * Hoy cuenta como día de estudio: vuelve a terminar su última actividad
   * terminada (no cambia el avance). false si no ha terminado ninguna.
   */
  private async studyToday(
    userId: string,
    eventId: string,
    completedAt: Map<string, Date> | undefined,
    now: Date,
  ): Promise<boolean> {
    const last = [...(completedAt || new Map<string, Date>()).entries()].sort(
      (a, b) => b[1].getTime() - a[1].getTime(),
    )[0];
    if (!last) return false;
    const [activityId] = last;
    await this.col('progress_events').insertOne({
      user_id: userId,
      event_id: eventId,
      activity_id: activityId,
      type: 'activity_progress',
      from: 100,
      to: 100,
      at: now,
      created_at: now,
      lab: LAB_TAG,
    });
    // También como última actividad: si no, tras varios días pasaría a inactivos
    await this.col('activityattendees').updateOne(
      { user_id: { $in: idVariants(userId) }, activity_id: { $in: idVariants(activityId) } },
      { $set: { updatedAt: now } },
    );
    return true;
  }

  private async shiftDay(
    e: GenOnEnrollment,
    userId: string,
    eventId: string,
    activityIds: string[],
  ) {
    const userVals = idVariants(userId);
    const eventVals = idVariants(eventId);
    await Promise.all([
      this.col('progress_events').updateMany({ user_id: userId, event_id: eventId }, [
        { $set: { at: minusDay('$at'), created_at: minusDay('$created_at') } },
      ]),
      this.col('activityattendees').updateMany(
        { user_id: { $in: userVals }, activity_id: { $in: activityIds.flatMap(idVariants) } },
        [{ $set: { createdAt: minusDay('$createdAt'), updatedAt: minusDay('$updatedAt') } }],
      ),
      this.col('courseattendees').updateMany(
        { user_id: { $in: userVals }, event_id: { $in: eventVals } },
        [
          {
            $set: {
              createdAt: minusDay('$createdAt'),
              updatedAt: minusDay('$updatedAt'),
              completed_at: minusDay('$completed_at'),
            },
          },
        ],
      ),
      // Tiempo en el curso: cuenta como última actividad para la segmentación
      this.col('useractivities').updateMany({ user_id: { $in: userVals } }, [
        {
          $set: {
            courses: {
              $map: {
                input: { $ifNull: ['$courses', []] },
                as: 'c',
                in: {
                  $cond: [
                    { $eq: [{ $toString: '$$c.event_id' }, eventId] },
                    { $mergeObjects: ['$$c', { last_updated: minusDay('$$c.last_updated') }] },
                    '$$c',
                  ],
                },
              },
            },
            activities: {
              $map: {
                input: { $ifNull: ['$activities', []] },
                as: 'a',
                in: {
                  $cond: [
                    { $eq: [{ $toString: '$$a.event_id' }, eventId] },
                    { $mergeObjects: ['$$a', { last_updated: minusDay('$$a.last_updated') }] },
                    '$$a',
                  ],
                },
              },
            },
          },
        },
      ]),
    ]);

    // Inscripción: retos, días puenteados y fechas del flujo
    await this.enrollmentModel.collection.updateOne({ _id: e._id as Types.ObjectId }, [
        {
          $set: {
            challenges: {
              $map: {
                input: { $ifNull: ['$challenges', []] },
                as: 'c',
                in: { $mergeObjects: ['$$c', { at: minusDay('$$c.at') }] },
              },
            },
            segment_since: minusDay('$segment_since'),
            segmented_at: minusDay('$segmented_at'),
            last_activity_at: minusDay('$last_activity_at'),
            enrolled_at: minusDay('$enrolled_at'),
            streak_bridged: { $literal: (e.streak_bridged || []).map((d) => addDays(d, -1)) },
            // El aviso de riesgo sale una vez por día y por semana: se olvida
            // para poder probarlo de nuevo. Los de racha en cola eran del
            // estado anterior; la próxima revisión encola los que tocan ahora
            streak_risk_week: null,
            fired: {
              $filter: {
                input: { $ifNull: ['$fired', []] },
                cond: { $not: { $regexMatch: { input: '$$this', regex: '^risk:' } } },
              },
            },
            queue: {
              $filter: {
                input: { $ifNull: ['$queue', []] },
                cond: { $not: { $in: ['$$this.key', STREAK_KEYS] } },
              },
            },
          },
        },
      ]);
  }
}
