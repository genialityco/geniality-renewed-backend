import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { localDate } from '../src/genon/genon-schedule';
import { localTime, slotOfTime } from '../src/genon/genon-slot-results';

dotenv.config();

/**
 * Reconstruye las inscripciones de Gen.ON (genon_enrollments) de un programa
 * a partir de su bitácora de mensajes (engagement_messages), para cuando se
 * borraron (p. ej. al volver a activar el programa).
 *
 * Por persona con mensajes recupera: el id original de la inscripción (los
 * botones de los mensajes ya enviados lo llevan), segmento y desde cuándo,
 * último toque y su día, franja, grupo de control, teléfono, último toque
 * enviado, disparadores ya enviados (no se repiten), y lo que respondió:
 * motivo de abandono, "no era lo que esperaba", baja, soporte.
 *
 * No recupera (se recalcula o se pierde): avance, racha, retos, cola de
 * disparadores pendientes ni la foto de módulos terminados. La siguiente
 * segmentación completa el avance y programa el próximo toque; como la
 * persona sigue en el mismo segmento, la secuencia continúa donde iba.
 * Quien no tenía mensajes se vuelve a inscribir solo en esa segmentación.
 *
 * No cambia el modo del programa: hay que volverlo a "live" (sin borrar) y
 * dejar last_segmented_on en null para que el cron vuelva a segmentar.
 *
 * Uso:
 *   npx ts-node scripts/restoreGenOnEnrollments.ts <programId> --dry-run
 *   npx ts-node scripts/restoreGenOnEnrollments.ts <programId>
 */

const SUPPORT_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
  const programId = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!programId || !mongoose.Types.ObjectId.isValid(programId)) {
    throw new Error('Uso: restoreGenOnEnrollments.ts <programId> [--dry-run]');
  }
  await mongoose.connect(process.env.MONGO_URI!);
  const db = mongoose.connection.db!;

  const program: any = await db
    .collection('genon_programs')
    .findOne({ _id: new mongoose.Types.ObjectId(programId) });
  if (!program) throw new Error('Programa no encontrado');
  const tz = program.timezone || 'America/Bogota';
  const slots: string[] = program.send_slots || [];

  const stepDay = new Map<string, number>();
  const abandonQuestions = new Set<string>();
  for (const steps of Object.values<any[]>(program.flows || {})) {
    for (const s of steps || []) {
      stepDay.set(s.key, s.day);
      if (s.mechanic === 'abandon_question') abandonQuestions.add(s.key);
    }
  }
  const replyByLabel = new Map<string, any>(
    (program.replies || []).map((r: any) => [String(r.label).trim().toLowerCase(), r]),
  );

  const messages: any[] = await db
    .collection('engagement_messages')
    .find({ program_id: programId, kind: 'genon' })
    .sort({ at: 1 })
    .toArray();

  // Inscripciones que ya existen (no se tocan)
  const existing = await db
    .collection('genon_enrollments')
    .find({ program_id: programId })
    .project({ _id: 1, user_id: 1, event_id: 1, test: 1 })
    .toArray();
  const existingIds = new Set(existing.map((e) => String(e._id)));
  const existingKeys = new Set(existing.map((e) => `${e.user_id}:${e.event_id}:${!!e.test}`));

  type Draft = Record<string, any> & { _msgs: any[] };
  const drafts = new Map<string, Draft>();
  let unparsed = 0;
  for (const m of messages) {
    const key = String(m.dedupe_key || '');
    const match = /^genon:([0-9a-f]{24}):(.+):(\d{4}-\d{2}-\d{2})$/.exec(key);
    if (!match) {
      unparsed++;
      continue;
    }
    const [, enrollmentId, middle] = match;
    const d =
      drafts.get(enrollmentId) ||
      ({ _msgs: [], fired: new Set<string>(), enrollmentId } as unknown as Draft);
    d._msgs.push(m);
    // Toque de secuencia: "<segment_since ms>:<paso>" (queda el último);
    // disparador: su clave de disparo (p. ej. "exam:<id>")
    const seq = /^(\d{12,}):([^:]+)$/.exec(middle);
    if (seq && stepDay.has(seq[2])) {
      d.flow = { segmentSince: new Date(Number(seq[1])), step: seq[2], m };
    } else {
      d.fired.add(middle);
    }
    drafts.set(enrollmentId, d);
  }

  const docs: any[] = [];
  const skipped: string[] = [];
  const summary: Record<string, number> = {};
  const count = (k: string) => (summary[k] = (summary[k] || 0) + 1);

  for (const d of drafts.values()) {
    const msgs = d._msgs;
    const first = msgs[0];
    const last = msgs[msgs.length - 1];
    const flowMsg = d.flow?.m;
    const segment = flowMsg?.segment || last.segment || 'active';
    const keyOf = `${first.user_id}:${first.event_id}:false`;
    if (existingIds.has(d.enrollmentId) || existingKeys.has(keyOf)) {
      skipped.push(d.enrollmentId);
      continue;
    }

    const doc: Record<string, any> = {
      _id: new mongoose.Types.ObjectId(d.enrollmentId),
      program_id: programId,
      organization_id: first.organization_id,
      event_id: first.event_id,
      user_id: first.user_id,
      segment,
      segment_since: d.flow?.segmentSince || first.at,
      last_step_key: d.flow?.step ?? null,
      last_step_day: d.flow ? stepDay.get(d.flow.step) ?? null : null,
      next_step_at: null,
      next_step_key: null,
      slot: slotOfTime(localTime((flowMsg || first).at, tz), slots),
      holdout: (flowMsg || first).status === 'holdout',
      variant_picks: {},
      paused: false,
      paused_at: null,
      exited: false,
      exit_reason: null,
      progress: flowMsg?.progress ?? first.progress ?? 0,
      completed_activities: flowMsg?.completed_activities ?? first.completed_activities ?? 0,
      last_activity_at: null,
      segmented_at: null,
      enrolled_at: null,
      without_course: false,
      phone_tail: [...msgs].reverse().find((x) => x.phone_tail)?.phone_tail ?? null,
      abandon_reason: null,
      awaiting_feedback: false,
      support_until: null,
      last_touch_at: [...msgs].reverse().find((x) => x.status !== 'holdout')?.at ?? null,
      last_error: null,
      challenges: [],
      queue: [],
      fired: [...d.fired],
      modules_done: null,
      streak: null,
      streak_bridged: [],
      streak_risk_week: null,
      streak_seen: [],
      test: false,
      test_phone: null,
      created_at: d.flow?.segmentSince || first.at,
      updated_at: new Date(),
    };
    // La franja debe ser una del programa (si el envío cayó fuera, la de la persona se sortea)
    if (!slots.includes(doc.slot)) doc.slot = null;

    // Respuestas a los mensajes, en orden
    for (const m of msgs) {
      if (m.opted_out_at) {
        doc.exited = true;
        doc.exit_reason = 'opt_out';
      }
      if (!m.reply_text) continue;
      const reply = replyByLabel.get(String(m.reply_text).trim().toLowerCase());
      if (!reply) continue;
      if (m.step && abandonQuestions.has(m.step)) doc.abandon_reason = reply.key;
      if (reply.effect === 'support_case') {
        doc.support_until = new Date(new Date(m.replied_at).getTime() + SUPPORT_WINDOW_DAYS * DAY_MS);
      } else if (reply.effect === 'feedback') {
        doc.exited = true;
        doc.exit_reason = 'not_expected';
        doc.awaiting_feedback = true;
      } else if (reply.effect === 'opt_out') {
        doc.exited = true;
        doc.exit_reason = 'opt_out';
      }
    }

    count(`segmento ${segment}${doc.holdout ? ' (control)' : ''} · último ${doc.last_step_key ?? '—'}`);
    if (doc.exited) count(`salió: ${doc.exit_reason}`);
    if (doc.abandon_reason) count(`motivo: ${doc.abandon_reason}`);
    if (doc.fired.length) count('con disparadores ya enviados');
    if (!doc.slot) count('sin franja (se sortea)');
    docs.push(doc);
  }

  console.log(`Programa ${program.name} (${program.mode}) · hoy ${localDate(new Date(), tz)}`);
  console.log(`Mensajes: ${messages.length} (sin clave reconocible: ${unparsed})`);
  console.log(`Inscripciones existentes: ${existing.length} · ya presentes (se omiten): ${skipped.length}`);
  console.log(`A restaurar: ${docs.length}`);
  console.table(summary);

  if (dryRun) {
    console.log('\n--dry-run: no se escribió nada. Ejemplo:');
    console.log(docs[0]);
  } else if (docs.length) {
    const res = await db.collection('genon_enrollments').insertMany(docs, { ordered: false });
    console.log(`Insertadas: ${res.insertedCount}`);
  }
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
