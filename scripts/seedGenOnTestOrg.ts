import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { randomUUID } from 'crypto';

dotenv.config();

/**
 * Organización de prueba para Gen.ON, con datos ficticios.
 *
 * Copia el curso "Hipotiroidismo sin restricciones" (ACE): módulos,
 * actividades con sus videos, transcripciones (con embeddings), banco de
 * preguntas y exámenes. Crea 8 usuarios ficticios, uno por situación de
 * Gen.ON, todos con el teléfono de prueba:
 *
 *   1-2  abandono  (sin actividades terminadas, inscritos hace 10 y 21 días)
 *   3-4  inactivos (con avance, sin actividad hace 20 y 35 días)
 *   5    activo con racha de 3 días (termina en ayer: racha en riesgo hoy)
 *   6    activo, terminó el módulo 1 hace poco
 *   7    terminó las actividades, sin exámenes (recordatorio de examen)
 *   8    terminó todo y aprobó los exámenes, sin certificado (certificado)
 *
 * Los usuarios no tienen cuenta en Firebase: no pueden iniciar sesión, pero
 * Gen.ON les escribe por WhatsApp. Los administradores de ACE quedan como
 * administradores de la organización de prueba.
 *
 * Todo documento creado lleva `seed_tag` para poder borrarlo.
 *
 * Uso:
 *   npx ts-node scripts/seedGenOnTestOrg.ts --dry-run   # solo reporta
 *   npx ts-node scripts/seedGenOnTestOrg.ts             # crea
 *   npx ts-node scripts/seedGenOnTestOrg.ts --cleanup   # borra lo creado
 */

const SEED_TAG = 'genon-prueba';
const SOURCE_EVENT_ID = '6a500d595b809f3cf38d4e45';
const SOURCE_ORG_ID = '6a4ffd695b809f3cf38d3a64';
const PHONE = '3133057451';
const COUNTRY_CODE = '57';
const ORG_NAME = '[PRUEBA] Gen.ON';
const DAY = 24 * 3600 * 1000;

const { ObjectId } = mongoose.Types;
type Oid = mongoose.Types.ObjectId;

const isOid = (v: unknown): v is Oid => v instanceof ObjectId;
const idVariants = (id: unknown) => [new ObjectId(String(id)), String(id)];

/** Cambia un id por el nuevo conservando el tipo del original (ObjectId o string). */
function remap(value: unknown, map: Map<string, Oid>): any {
  if (value === null || value === undefined) return value;
  const next = map.get(String(value));
  if (!next) return value;
  return isOid(value) ? next : String(next);
}

/** Copia de un documento sin _id, con la marca de la semilla. */
function clone(doc: Record<string, any>, changes: Record<string, any>) {
  const { _id, __v, ...rest } = doc;
  return { ...rest, ...changes, seed_tag: SEED_TAG };
}

interface Persona {
  key: string;
  nombres: string;
  apellidos: string;
  enrolledDaysAgo: number;
  /** Actividades terminadas (en orden) y hace cuántos días cada una */
  completed: number[];
  /** Actividad empezada sin terminar: [índice, avance, hace días] */
  partial?: [number, number, number];
  passExams?: boolean;
}

const PERSONAS: Persona[] = [
  { key: 'abandono1', nombres: 'Laura', apellidos: 'Abandono Uno', enrolledDaysAgo: 10, completed: [] },
  { key: 'abandono2', nombres: 'Andrés', apellidos: 'Abandono Dos', enrolledDaysAgo: 21, completed: [], partial: [0, 30, 19] },
  { key: 'inactivo1', nombres: 'Camila', apellidos: 'Inactiva Uno', enrolledDaysAgo: 60, completed: [24, 20] },
  { key: 'inactivo2', nombres: 'Julián', apellidos: 'Inactivo Dos', enrolledDaysAgo: 90, completed: [50, 45, 40, 35] },
  { key: 'activo_racha', nombres: 'Valentina', apellidos: 'Racha Activa', enrolledDaysAgo: 20, completed: [3, 2, 1] },
  { key: 'activo_modulo', nombres: 'Santiago', apellidos: 'Módulo Terminado', enrolledDaysAgo: 15, completed: [5, 1], partial: [2, 40, 1] },
  { key: 'examen', nombres: 'Daniela', apellidos: 'Examen Pendiente', enrolledDaysAgo: 40, completed: [24, 21, 18, 15, 12, 9, 6, 3] },
  { key: 'graduado', nombres: 'Felipe', apellidos: 'Graduado Prueba', enrolledDaysAgo: 50, completed: [40, 36, 32, 28, 24, 20, 16, 12], passExams: true },
];

/** Correo de prueba: primer nombre sin tildes (andres@prueba.com); sin "+", que no lo aceptan. */
const testEmail = (nombres: string) =>
  `${nombres.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()}@prueba.com`;

// Colecciones donde la semilla escribe (para el borrado)
const COLLECTIONS = [
  'organizations',
  'organizationusers',
  'users',
  'events',
  'modules',
  'activities',
  'transcript_segments',
  'activity_questions',
  'quizzes',
  'courseattendees',
  'activityattendees',
  'progress_events',
  'UserAttemptsQuiz',
];

async function cleanup(db: mongoose.Connection, dryRun: boolean) {
  const org = await db.collection('organizations').findOne({ seed_tag: SEED_TAG });
  for (const name of COLLECTIONS) {
    const n = await db.collection(name).countDocuments({ seed_tag: SEED_TAG });
    if (!dryRun && n) await db.collection(name).deleteMany({ seed_tag: SEED_TAG });
    console.log(`${dryRun ? '[dry-run] ' : ''}${name}: ${n} borrados`);
  }
  // Lo que Gen.ON creó al trabajar con la organización
  if (org) {
    const orgId = String(org._id);
    const enrollments = await db.collection('genon_enrollments').countDocuments({ organization_id: orgId });
    if (!dryRun && enrollments) {
      await db.collection('genon_enrollments').deleteMany({ organization_id: orgId });
    }
    console.log(`${dryRun ? '[dry-run] ' : ''}genon_enrollments: ${enrollments} borrados`);
  }
}

async function seed(db: mongoose.Connection, dryRun: boolean) {
  if (await db.collection('organizations').findOne({ seed_tag: SEED_TAG })) {
    throw new Error('La organización de prueba ya existe. Bórrala primero con --cleanup.');
  }
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  // ── Origen ──
  const sourceOrg = await db.collection('organizations').findOne({ _id: new ObjectId(SOURCE_ORG_ID) });
  const sourceEvent = await db.collection('events').findOne({ _id: new ObjectId(SOURCE_EVENT_ID) });
  if (!sourceOrg || !sourceEvent) throw new Error('No se encontró el curso o la organización de origen');
  const eventVals = idVariants(SOURCE_EVENT_ID);
  const modules = await db.collection('modules').find({ event_id: { $in: eventVals } }).toArray();
  const activities = await db.collection('activities').find({ event_id: { $in: eventVals } }).toArray();
  const activityVals = activities.flatMap((a) => idVariants(a._id));
  const [segments, questions, quizzes, admins] = await Promise.all([
    db.collection('transcript_segments').find({ activity_id: { $in: activityVals } }).toArray(),
    db.collection('activity_questions').find({ activity_id: { $in: activityVals } }).toArray(),
    db.collection('quizzes').find({ eventId: { $in: eventVals } }).toArray(),
    db
      .collection('organizationusers')
      .find({
        organization_id: { $in: idVariants(SOURCE_ORG_ID) },
        rol_id: { $regex: /^(admin|owner|super_admin)$/i },
      })
      .toArray(),
  ]);

  // Mismo orden que Gen.ON: módulo, creación, nombre
  const moduleOrder = new Map(modules.map((m) => [String(m._id), m.order ?? Number.MAX_SAFE_INTEGER]));
  const ordered = [...activities].sort(
    (a, b) =>
      (moduleOrder.get(String(a.module_id)) ?? Number.MAX_SAFE_INTEGER) -
        (moduleOrder.get(String(b.module_id)) ?? Number.MAX_SAFE_INTEGER) ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      String(a.name).localeCompare(String(b.name)),
  );

  // ── Ids nuevos ──
  const map = new Map<string, Oid>();
  const orgId = new ObjectId();
  const eventId = new ObjectId();
  map.set(SOURCE_ORG_ID, orgId);
  map.set(SOURCE_EVENT_ID, eventId);
  for (const m of modules) map.set(String(m._id), new ObjectId());
  for (const a of activities) map.set(String(a._id), new ObjectId());
  const newActivityId = (i: number) => map.get(String(ordered[i]._id))!;

  const docs: Record<string, any[]> = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));

  docs.organizations.push({
    _id: orgId,
    name: ORG_NAME,
    author: sourceOrg.author,
    description: 'Organización de prueba de Gen.ON con datos ficticios. Se borra con el script de la semilla.',
    access_settings: sourceOrg.access_settings,
    visibility: 'PRIVATE',
    user_properties: sourceOrg.user_properties || [],
    styles: sourceOrg.styles || {},
    tab_titles: sourceOrg.tab_titles || {},
    tab_visibility: sourceOrg.tab_visibility || {},
    createdAt: now,
    updatedAt: now,
    seed_tag: SEED_TAG,
  });
  for (const a of admins) {
    // Sin plan de pago: es de la organización de origen
    const { payment_plan_id, ...membership } = a;
    docs.organizationusers.push(
      clone(membership, { organization_id: orgId, created_at: now, updated_at: now }),
    );
  }

  docs.events.push(
    clone(sourceEvent, {
      _id: eventId,
      name: `[PRUEBA] ${String(sourceEvent.name).trim()}`,
      organizer_id: remap(sourceEvent.organizer_id, map),
      visibility: 'PRIVATE',
      createdAt: now,
      updatedAt: now,
    }),
  );
  for (const m of modules) {
    docs.modules.push(
      clone(m, { _id: map.get(String(m._id)), event_id: remap(m.event_id, map), created_at: now, updated_at: now }),
    );
  }
  // Las actividades conservan su fecha de creación relativa (define el orden)
  for (const a of activities) {
    docs.activities.push(
      clone(a, {
        _id: map.get(String(a._id)),
        event_id: remap(a.event_id, map),
        module_id: remap(a.module_id, map),
        organization_id: remap(a.organization_id, map),
        updatedAt: now,
      }),
    );
  }
  for (const s of segments) {
    docs.transcript_segments.push(clone(s, { activity_id: remap(s.activity_id, map) }));
  }
  for (const q of questions) {
    docs.activity_questions.push(
      clone(q, {
        activity_id: remap(q.activity_id, map),
        event_id: remap(q.event_id, map),
        module_id: remap(q.module_id, map),
        organization_id: remap(q.organization_id, map),
      }),
    );
  }
  const newQuizIds: Oid[] = [];
  for (const z of quizzes) {
    const _id = new ObjectId();
    newQuizIds.push(_id);
    docs.quizzes.push(
      clone(z, {
        _id,
        id: randomUUID(),
        eventId: remap(z.eventId, map),
        moduleId: remap(z.moduleId, map),
        userAttempts: [],
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  // ── Personas ──
  const total = ordered.length;
  PERSONAS.forEach((p, n) => {
    const userId = new ObjectId();
    const email = testEmail(p.nombres);
    const enrolledAt = ago(p.enrolledDaysAgo);
    docs.users.push({
      _id: userId,
      uid: `seed-${SEED_TAG}-${p.key}`,
      names: `${p.nombres} ${p.apellidos}`,
      email,
      phone: `${COUNTRY_CODE}${PHONE}`,
      sessionTokens: [],
      createdAt: enrolledAt,
      updatedAt: enrolledAt,
      seed_tag: SEED_TAG,
    });
    docs.organizationusers.push({
      organization_id: orgId,
      user_id: userId,
      rol_id: 'attendee',
      memberShipStatus: true,
      whatsapp_opt_in: true,
      whatsapp_opt_in_at: enrolledAt,
      whatsapp_opt_out_at: null,
      properties: {
        ID: `PRUEBA-${1000 + n}`,
        nombres: p.nombres,
        apellidos: p.apellidos,
        indicativodepais: COUNTRY_CODE,
        phone: PHONE,
        email,
        pais: 'Colombia',
        city: 'Bogotá D.C.',
        departamento: 'Cundinamarca',
        perfilProfesional: 'Médico General',
        especialidad: 'No aplica',
        especialidadsubespecialidad: 'No aplica',
        soyProfesionalSalud: true,
        consentimientoProfSalud: true,
      },
      created_at: enrolledAt,
      updated_at: enrolledAt,
      seed_tag: SEED_TAG,
    });

    const progress = Math.round((p.completed.length / total) * 100);
    const lastCompleted = p.completed.length ? Math.min(...p.completed) : null;
    const completedAt = progress >= 100 && lastCompleted !== null ? ago(lastCompleted) : null;
    // Mismos tipos que los registros reales: user_id string, event_id ObjectId
    docs.courseattendees.push({
      user_id: String(userId),
      event_id: eventId,
      status: 'ACTIVE',
      progress,
      completed_at: completedAt,
      createdAt: enrolledAt,
      updatedAt: lastCompleted !== null ? ago(lastCompleted) : enrolledAt,
      seed_tag: SEED_TAG,
    });

    const studied: [number, number, number][] = p.completed.map((days, i) => [i, 100, days]);
    if (p.partial) studied.push(p.partial);
    for (const [index, value, days] of studied) {
      const at = ago(days);
      const activityId = String(newActivityId(index));
      docs.activityattendees.push({
        user_id: String(userId),
        activity_id: activityId,
        event_id: eventId,
        progress: value,
        createdAt: at,
        updatedAt: at,
        seed_tag: SEED_TAG,
      });
      docs.progress_events.push({
        user_id: String(userId),
        event_id: String(eventId),
        activity_id: activityId,
        type: 'activity_progress',
        from: 0,
        to: value,
        at,
        created_at: at,
        seed_tag: SEED_TAG,
      });
    }
    if (completedAt) {
      docs.progress_events.push({
        user_id: String(userId),
        event_id: String(eventId),
        activity_id: null,
        type: 'course_completed',
        from: 0,
        to: 100,
        at: completedAt,
        created_at: completedAt,
        seed_tag: SEED_TAG,
      });
    }
    if (p.passExams) {
      newQuizIds.forEach((quizId, i) => {
        const at = ago(10 - i);
        docs.UserAttemptsQuiz.push({
          quizId: String(quizId),
          userId: String(userId),
          attemptedAt: at,
          status: 'graded',
          score: 90,
          userAnswers: [],
          manualScores: [],
          createdAt: at,
          updatedAt: at,
          seed_tag: SEED_TAG,
        });
      });
    }
  });

  for (const name of COLLECTIONS) {
    console.log(`${dryRun ? '[dry-run] ' : ''}${name}: ${docs[name].length}`);
    if (!dryRun && docs[name].length) await db.collection(name).insertMany(docs[name]);
  }
  console.log(`\nOrganización: ${ORG_NAME} (${orgId})`);
  console.log(`Curso: [PRUEBA] ${String(sourceEvent.name).trim()} (${eventId})`);
  console.log(`Teléfono de los ${PERSONAS.length} usuarios: +${COUNTRY_CODE} ${PHONE}`);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const uri = process.env.MONGO_URI || 'mongodb://localhost/geniality';
  await mongoose.connect(uri);
  try {
    if (process.argv.includes('--cleanup')) await cleanup(mongoose.connection, dryRun);
    else await seed(mongoose.connection, dryRun);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
