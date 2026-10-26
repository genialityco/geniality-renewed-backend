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
    const org = Types.ObjectId.isValid(course.organizationId)
      ? await this.col('organizations').findOne(
          { _id: new Types.ObjectId(course.organizationId) },
          { projection: { seed_tag: 1 } },
        )
      : null;
    if (!org?.seed_tag) {
      throw new BadRequestException(
        'El laboratorio de rachas solo funciona en una organización de prueba: cambia las fechas de estudio de la persona.',
      );
    }
    const e = await this.enrollmentModel
      .findOne({ program_id: String(program._id), event_id: eventId, user_id: userId, test: false })
      .exec();
    if (!e) {
      throw new BadRequestException('La persona aún no está segmentada en el programa.');
    }

    if (action === 'study') {
      // Su última actividad terminada: volver a terminarla no cambia el avance
      const completedAt = stats.completedAt.get(userId) || new Map<string, Date>();
      const last = [...completedAt.entries()].sort((a, b) => b[1].getTime() - a[1].getTime())[0];
      if (!last) {
        throw new BadRequestException(
          'Para tener racha la persona debe haber terminado al menos una actividad del curso.',
        );
      }
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
    } else {
      await this.shiftDay(e, userId, eventId, course.activities.map((a) => a.id));
    }
    return this.triggers.simulateForUser(program, userId, eventId);
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
          },
        },
      ]);
  }
}
