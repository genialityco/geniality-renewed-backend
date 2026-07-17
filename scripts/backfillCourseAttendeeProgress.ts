import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Backfill de CourseAttendee.progress a partir de las actividades completadas.
 *
 * La sincronización automática (ActivityAttendeeService.syncCourseProgress)
 * solo corre cuando un usuario completa una actividad desde que ese código
 * existe; los registros históricos quedaron con progress 0 aunque el usuario
 * tenga actividades completadas. Este script recalcula el progreso de curso
 * (actividades completadas / total de actividades) para cada par
 * usuario+evento y lo aplica con $max (nunca baja un progreso ya guardado).
 *
 * La data es heterogénea (ids como string u ObjectId, event_id ausente en
 * activity-attendees viejos), así que todo se normaliza a string para agrupar
 * y se escribe por _id.
 *
 * Uso:
 *   npx ts-node scripts/backfillCourseAttendeeProgress.ts --dry-run   # solo reporta
 *   npx ts-node scripts/backfillCourseAttendeeProgress.ts            # aplica cambios
 */
async function backfillCourseAttendeeProgress() {
  const dryRun = process.argv.includes('--dry-run');

  const uri =
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    'mongodb://localhost/geniality';
  await mongoose.connect(uri);
  console.log(`✅ Conectado a MongoDB${dryRun ? ' (DRY RUN, no se escribe nada)' : ''}`);

  const db = mongoose.connection;
  const activitiesCol = db.collection('activities');
  const activityAttendeesCol = db.collection('activityattendees');
  const courseAttendeesCol = db.collection('courseattendees');

  // 1. Actividades por evento (claves normalizadas a string).
  const activities = await activitiesCol
    .find({ event_id: { $exists: true, $ne: null } })
    .project({ _id: 1, event_id: 1 })
    .toArray();

  const eventByActivity = new Map<string, string>();
  const totalActivitiesByEvent = new Map<string, number>();
  const rawEventIdByKey = new Map<string, any>();
  for (const a of activities) {
    const eventKey = String(a.event_id);
    eventByActivity.set(String(a._id), eventKey);
    totalActivitiesByEvent.set(
      eventKey,
      (totalActivitiesByEvent.get(eventKey) ?? 0) + 1,
    );
    if (!rawEventIdByKey.has(eventKey)) rawEventIdByKey.set(eventKey, a.event_id);
  }
  console.log(
    `🔍 ${activities.length} actividades en ${totalActivitiesByEvent.size} eventos`,
  );

  // 2. Actividades completadas por usuario+evento. El event_id del attendee
  //    puede faltar o estar en otro tipo: se resuelve siempre vía activity_id.
  //    Set de activity_id para dedupe (duplicados string/ObjectId).
  const completedByUserEvent = new Map<string, Set<string>>();
  const attendeeCursor = activityAttendeesCol
    .find({ progress: { $gte: 100 } })
    .project({ user_id: 1, activity_id: 1 });

  for await (const doc of attendeeCursor) {
    const activityKey = String(doc.activity_id);
    const eventKey = eventByActivity.get(activityKey);
    if (!eventKey || doc.user_id == null) continue;
    const key = `${eventKey}|${String(doc.user_id)}`;
    let set = completedByUserEvent.get(key);
    if (!set) {
      set = new Set<string>();
      completedByUserEvent.set(key, set);
    }
    set.add(activityKey);
  }
  console.log(
    `🔍 ${completedByUserEvent.size} pares usuario+evento con actividades completadas`,
  );

  // 3. Inscripciones existentes, indexadas por la misma clave normalizada.
  //    Puede haber duplicados (ids en distinto tipo): se guardan todos los _id
  //    y el mejor progreso ya almacenado.
  const enrollmentByKey = new Map<
    string,
    { ids: any[]; maxProgress: number }
  >();
  const enrollmentCursor = courseAttendeesCol
    .find({})
    .project({ user_id: 1, event_id: 1, progress: 1 });

  for await (const doc of enrollmentCursor) {
    if (doc.user_id == null || doc.event_id == null) continue;
    const key = `${String(doc.event_id)}|${String(doc.user_id)}`;
    const entry = enrollmentByKey.get(key);
    const progress = typeof doc.progress === 'number' ? doc.progress : 0;
    if (entry) {
      entry.ids.push(doc._id);
      entry.maxProgress = Math.max(entry.maxProgress, progress);
    } else {
      enrollmentByKey.set(key, { ids: [doc._id], maxProgress: progress });
    }
  }

  // 4. Calcular qué hay que actualizar/insertar.
  const updates: { ids: any[]; progress: number }[] = [];
  const inserts: { user_id: string; event_id: any; progress: number }[] = [];
  const byEventSummary = new Map<string, { updated: number; inserted: number }>();

  for (const [key, completedSet] of completedByUserEvent) {
    const [eventKey, userId] = key.split('|');
    const total = totalActivitiesByEvent.get(eventKey);
    if (!total) continue;
    const progress = Math.min(
      100,
      Math.round((completedSet.size / total) * 100),
    );
    if (progress <= 0) continue;

    const summary = byEventSummary.get(eventKey) ?? { updated: 0, inserted: 0 };
    const enrollment = enrollmentByKey.get(key);
    if (enrollment) {
      if (progress > enrollment.maxProgress) {
        updates.push({ ids: enrollment.ids, progress });
        summary.updated++;
      }
    } else {
      // Completó actividades pero nunca quedó inscrito: se crea el registro,
      // con los mismos tipos que usa CourseAttendeeService.createOrUpdate.
      inserts.push({
        user_id: userId,
        event_id: rawEventIdByKey.get(eventKey) ?? eventKey,
        progress,
      });
      summary.inserted++;
    }
    if (summary.updated || summary.inserted) byEventSummary.set(eventKey, summary);
  }

  console.log(`\n📊 Cambios calculados:`);
  console.log(`   ✏️  Inscripciones a actualizar (progress sube): ${updates.length}`);
  console.log(`   ➕ Inscripciones a crear (completó sin registro): ${inserts.length}`);

  const topEvents = [...byEventSummary.entries()]
    .sort((a, b) => b[1].updated + b[1].inserted - (a[1].updated + a[1].inserted))
    .slice(0, 15);
  console.log(`\n📋 Eventos con más cambios:`);
  for (const [eventKey, s] of topEvents) {
    console.log(`   ${eventKey}: ${s.updated} actualizados, ${s.inserted} nuevos`);
  }

  if (dryRun) {
    console.log('\n🟡 DRY RUN: no se escribió nada. Ejecuta sin --dry-run para aplicar.');
    await mongoose.disconnect();
    return;
  }

  // 5. Aplicar en lotes.
  const BATCH = 500;
  let applied = 0;
  const now = new Date();

  const updateOps = updates.map((u) => ({
    updateMany: {
      filter: { _id: { $in: u.ids } },
      update: {
        $max: { progress: u.progress },
        $set: { updatedAt: now },
      },
    },
  }));
  const insertOps = inserts.map((i) => ({
    insertOne: {
      document: {
        user_id: i.user_id,
        event_id: i.event_id,
        status: 'ACTIVE',
        progress: i.progress,
        createdAt: now,
        updatedAt: now,
      },
    },
  }));

  const allOps = [...updateOps, ...insertOps];
  for (let i = 0; i < allOps.length; i += BATCH) {
    const batch = allOps.slice(i, i + BATCH);
    const result = await courseAttendeesCol.bulkWrite(batch as any, {
      ordered: false,
    });
    applied += (result.modifiedCount ?? 0) + (result.insertedCount ?? 0);
    console.log(`   … lote ${Math.floor(i / BATCH) + 1}: ${applied}/${allOps.length}`);
  }

  console.log(`\n✅ Backfill completado: ${applied} escrituras aplicadas`);
  await mongoose.disconnect();
}

backfillCourseAttendeeProgress().catch((error) => {
  console.error('❌ Error durante el backfill:', error);
  process.exit(1);
});
