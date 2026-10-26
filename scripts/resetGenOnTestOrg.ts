import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Reinicia los usuarios de prueba de "[PRUEBA] Gen.ON" (ver
 * seedGenOnTestOrg.ts) y los reparte por grupo de Gen.ON:
 *
 *   abandono   Laura, Andrés, Pablo   (sin actividades terminadas)
 *   inactivos  Camila, Julián         (con avance, sin actividad hace 20+ días)
 *   activos    Valentina              (racha de 3 días hasta ayer: hito y racha en riesgo)
 *              Santiago               (le falta 1 actividad para terminar el módulo 1)
 *   examen     Daniela                (módulo 1 terminado hace 3 días, sin examen)
 *   egresado   Felipe                 (todo terminado y exámenes aprobados: certificado)
 *
 * Por persona: borra su avance en el curso de prueba (actividades, eventos de
 * avance, exámenes, certificados, tiempo en useractivities), escribe el del
 * escenario, le devuelve el consentimiento de WhatsApp y borra su historial
 * de Gen.ON (mensajes, comentarios, inscripción). Deja una inscripción nueva
 * ya en su segmento, recién llegada (la secuencia arranca en el día 0) y fuera
 * del grupo de control: con el 20 % del programa, el sorteo dejaba sin
 * mensajes a varios. La segmentación lo conserva mientras no cambie de
 * segmento. Marca el programa para que vuelva a segmentar en la próxima
 * pasada del cron. Las personas se buscan por correo.
 *
 * Uso:
 *   npx ts-node scripts/resetGenOnTestOrg.ts --dry-run   # solo reporta
 *   npx ts-node scripts/resetGenOnTestOrg.ts             # aplica
 *   ... --end-demos   # además termina las demostraciones del programa
 *                     # (borra a sus participantes); sin él se conservan
 *
 * Mejor no correrlo a la hora en punto ni a los cuartos: el cron segmenta
 * cada 15 minutos y puede pasar a mitad del reinicio.
 */

const ORG_ID = '6ada6d2ab4d306c546cb8e38';
const EVENT_ID = '6ada6d2ab4d306c546cb8e39';
const PHONE = '3133057451';
const COUNTRY_CODE = '57';
const DAY = 24 * 3600 * 1000;

const { ObjectId } = mongoose.Types;
const idVariants = (id: unknown) =>
  ObjectId.isValid(String(id))
    ? [String(id), new ObjectId(String(id))]
    : [String(id)];

interface Persona {
  email: string;
  group: string;
  /** Segmento en que queda (debe coincidir con la clasificación de Gen.ON) */
  segment: 'abandon' | 'inactive' | 'active' | 'graduated';
  enrolledDaysAgo: number;
  /** Actividades terminadas (posición en el orden del curso) y hace cuántos días */
  completed: [index: number, daysAgo: number][];
  /** Actividad empezada sin terminar: [posición, avance, hace días] */
  partial?: [number, number, number];
  /** Todas las actividades y los exámenes aprobados */
  graduate?: boolean;
}

const PERSONAS: Persona[] = [
  {
    email: 'laura@prueba.com',
    group: 'abandono',
    segment: 'abandon',
    enrolledDaysAgo: 10,
    completed: [],
  },
  {
    email: 'abandono2@example.com',
    group: 'abandono',
    segment: 'abandon',
    enrolledDaysAgo: 21,
    completed: [],
    partial: [0, 30, 19],
  },
  {
    email: 'abandono3@example.com',
    group: 'abandono',
    segment: 'abandon',
    enrolledDaysAgo: 14,
    completed: [],
  },
  {
    email: 'camila@prueba.com',
    group: 'inactivos',
    segment: 'inactive',
    enrolledDaysAgo: 60,
    completed: [
      [0, 24],
      [1, 20],
    ],
  },
  {
    email: 'julian@prueba.com',
    group: 'inactivos',
    segment: 'inactive',
    enrolledDaysAgo: 90,
    completed: [
      [0, 50],
      [1, 45],
      [2, 40],
      [3, 35],
    ],
  },
  {
    email: 'valentina@prueba.com',
    group: 'activos (racha)',
    segment: 'active',
    enrolledDaysAgo: 20,
    completed: [
      [0, 3],
      [1, 2],
      [2, 1],
    ],
  },
  {
    email: 'santiago@prueba.com',
    group: 'activos (módulo)',
    segment: 'active',
    enrolledDaysAgo: 15,
    completed: [[0, 2]],
    partial: [1, 40, 1],
  },
  {
    email: 'daniela@prueba.com',
    group: 'examen',
    segment: 'active',
    enrolledDaysAgo: 30,
    completed: [
      [0, 4],
      [1, 3],
    ],
  },
  {
    email: 'felipe@prueba.com',
    group: 'egresado',
    segment: 'graduated',
    enrolledDaysAgo: 50,
    completed: [],
    graduate: true,
  },
];

/** Usuario huérfano de la semilla (Andrés sin membresía): sale del curso y de Gen.ON. */
const ORPHAN_EMAIL = 'genon.prueba+abandono2@example.com';
/** Administrador inscrito en el curso: sale del curso y de Gen.ON (sigue siendo admin). */
const ADMIN_EMAIL = 'procaps@geniality.com.co';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const log = (msg: string) =>
    console.log(`${dryRun ? '[dry-run] ' : ''}${msg}`);
  await mongoose.connect(
    process.env.MONGO_URI || 'mongodb://localhost/geniality',
  );
  const db = mongoose.connection;
  const col = (name: string) => db.collection(name);
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const eventVals = idVariants(EVENT_ID);
  const orgVals = idVariants(ORG_ID);

  try {
    const program = await col('genon_programs').findOne({
      organization_ids: ORG_ID,
    });
    if (!program)
      throw new Error(
        'No hay programa de Gen.ON para la organización de prueba',
      );
    const programId = String(program._id);

    // Orden de Gen.ON: módulo, creación, nombre
    const modules = await col('modules')
      .find({ event_id: { $in: eventVals } })
      .toArray();
    const moduleOrder = new Map(
      modules.map((m) => [String(m._id), m.order ?? Number.MAX_SAFE_INTEGER]),
    );
    const activities = (
      await col('activities')
        .find({ event_id: { $in: eventVals } })
        .toArray()
    ).sort(
      (a, b) =>
        (moduleOrder.get(String(a.module_id)) ?? Number.MAX_SAFE_INTEGER) -
          (moduleOrder.get(String(b.module_id)) ?? Number.MAX_SAFE_INTEGER) ||
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
        String(a.name).localeCompare(String(b.name)),
    );
    const activityVals = activities.flatMap((a) => idVariants(a._id));
    const quizzes = await col('quizzes')
      .find({ eventId: { $in: eventVals }, enabled: { $ne: false } })
      .project({ _id: 1, id: 1 })
      .toArray();
    const quizKeys = quizzes.flatMap((q: any) =>
      [String(q._id), q.id].filter(Boolean),
    );

    /** Borra todo lo de la persona en el curso de prueba y en Gen.ON. */
    const wipe = async (userId: string, keepAttendee: boolean) => {
      // Antes de armar las operaciones: cada deleteMany corre al crearse
      if (dryRun) return;
      const userVals = idVariants(userId);
      const ops: [string, Promise<{ deletedCount?: number }>][] = [
        [
          'activityattendees',
          col('activityattendees').deleteMany({
            user_id: { $in: userVals },
            activity_id: { $in: activityVals },
          }),
        ],
        [
          'progress_events',
          col('progress_events').deleteMany({
            user_id: userId,
            event_id: EVENT_ID,
          }),
        ],
        [
          'UserAttemptsQuiz',
          col('UserAttemptsQuiz').deleteMany({
            userId,
            quizId: { $in: quizKeys },
          }),
        ],
        [
          'certificates',
          col('certificates').deleteMany({
            userId: { $in: userVals },
            eventId: { $in: eventVals },
          }),
        ],
        [
          'engagement_messages',
          col('engagement_messages').deleteMany({
            user_id: userId,
            program_id: programId,
          }),
        ],
        [
          'genon_feedback',
          col('genon_feedback').deleteMany({
            user_id: userId,
            program_id: programId,
          }),
        ],
        [
          'genon_enrollments',
          col('genon_enrollments').deleteMany({
            user_id: userId,
            program_id: programId,
            test: false,
          }),
        ],
      ];
      if (!keepAttendee) {
        ops.push([
          'courseattendees',
          col('courseattendees').deleteMany({
            user_id: { $in: userVals },
            event_id: { $in: eventVals },
          }),
        ]);
      }
      await Promise.all(ops.map(([, p]) => p));
      // Tiempo en el curso (cuenta como última actividad para la segmentación)
      const ua = await col('useractivities').findOne({
        user_id: { $in: userVals },
      });
      if (ua) {
        const ms = (rows: any[]) =>
          rows.reduce((s, r) => s + (Number(r.time_spent_ms) || 0), 0);
        const courses = (ua.courses || []).filter(
          (c: any) => String(c.event_id) === EVENT_ID,
        );
        const acts = (ua.activities || []).filter(
          (a: any) => String(a.event_id) === EVENT_ID,
        );
        if (courses.length || acts.length) {
          await col('useractivities').updateOne(
            { _id: ua._id },
            {
              $pull: {
                courses: { event_id: { $in: eventVals } },
                activities: { event_id: { $in: eventVals } },
              } as any,
              $inc: {
                total_courses_time_ms: -ms(courses),
                total_activities_time_ms: -ms(acts),
              },
            },
          );
        }
      }
    };

    // ── Personas de prueba ──
    for (const p of PERSONAS) {
      const user = await col('users').findOne({ email: p.email });
      if (!user) throw new Error(`No existe el usuario ${p.email}`);
      const userId = String(user._id);
      const membership = await col('organizationusers').findOne({
        user_id: { $in: idVariants(userId) },
        organization_id: { $in: orgVals },
      });
      if (!membership)
        throw new Error(
          `${p.email} no es miembro de la organización de prueba`,
        );

      const done: [number, number][] = p.graduate
        ? activities.map((_, i) => [i, 12 + 3 * (activities.length - 1 - i)])
        : p.completed.filter(([i]) => activities[i]);
      const progress = Math.round((done.length / activities.length) * 100);
      const lastDone = done.length
        ? ago(Math.min(...done.map(([, d]) => d)))
        : null;
      const completedAt = progress >= 100 ? lastDone : null;
      const enrolledAt = ago(p.enrolledDaysAgo);
      const doneIds = new Set(done.map(([i]) => String(activities[i]._id)));
      // Módulos ya terminados: Gen.ON no felicita por estos, sí por el siguiente
      const modulesDone = modules
        .filter((m) => {
          const ids = activities
            .filter((a) => String(a.module_id) === String(m._id))
            .map((a) => String(a._id));
          return ids.length > 0 && ids.every((id) => doneIds.has(id));
        })
        .map((m) => String(m._id));
      log(
        `${user.names} (${p.email}) → ${p.group}: ${done.length} actividades, ${progress} %` +
          (p.partial
            ? `, actividad ${p.partial[0] + 1} al ${p.partial[1]} %`
            : '') +
          (p.graduate ? `, ${quizzes.length} exámenes aprobados` : ''),
      );

      await wipe(userId, true);
      if (dryRun) continue;

      await col('courseattendees').updateOne(
        { user_id: { $in: idVariants(userId) }, event_id: { $in: eventVals } },
        {
          $set: {
            status: 'ACTIVE',
            progress,
            completed_at: completedAt,
            createdAt: enrolledAt,
            updatedAt: lastDone || enrolledAt,
          },
          $setOnInsert: { user_id: userId, event_id: new ObjectId(EVENT_ID) },
        },
        { upsert: true },
      );
      const studied: [number, number, number][] = done.map(([i, d]) => [
        i,
        100,
        d,
      ]);
      if (p.partial) studied.push(p.partial);
      if (studied.length) {
        await col('activityattendees').insertMany(
          studied.map(([i, value, d]) => ({
            user_id: userId,
            activity_id: String(activities[i]._id),
            event_id: new ObjectId(EVENT_ID),
            progress: value,
            createdAt: ago(d),
            updatedAt: ago(d),
          })),
        );
        await col('progress_events').insertMany([
          ...studied.map(([i, value, d]) => ({
            user_id: userId,
            event_id: EVENT_ID,
            activity_id: String(activities[i]._id),
            type: 'activity_progress',
            from: 0,
            to: value,
            at: ago(d),
            created_at: ago(d),
          })),
          ...(completedAt
            ? [
                {
                  user_id: userId,
                  event_id: EVENT_ID,
                  activity_id: null,
                  type: 'course_completed',
                  from: 0,
                  to: 100,
                  at: completedAt,
                  created_at: completedAt,
                },
              ]
            : []),
        ]);
      }
      if (p.graduate && quizzes.length) {
        await col('UserAttemptsQuiz').insertMany(
          quizzes.map((q: any, i: number) => ({
            quizId: String(q._id),
            userId,
            attemptedAt: ago(10 - i),
            status: 'graded',
            score: 90,
            userAnswers: [],
            manualScores: [],
            createdAt: ago(10 - i),
            updatedAt: ago(10 - i),
          })),
        );
      }
      await col('organizationusers').updateOne(
        { _id: membership._id },
        {
          $set: {
            memberShipStatus: true,
            whatsapp_opt_in: true,
            whatsapp_opt_in_at: enrolledAt,
            whatsapp_opt_out_at: null,
            'properties.phone': PHONE,
            'properties.indicativodepais': COUNTRY_CODE,
          },
        },
      );
      // Inscripción nueva en su segmento: la segmentación conserva el día 0,
      // la secuencia y que no esté en el grupo de control. Upsert: si el cron
      // pasa mientras corre el script, ya pudo crearla entre el borrado y aquí
      await col('genon_enrollments').updateOne(
        {
          program_id: programId,
          event_id: EVENT_ID,
          user_id: userId,
          test: false,
        },
        {
          $set: {
            organization_id: ORG_ID,
            segment: p.segment,
            segment_since: now,
            last_step_key: null,
            last_step_day: null,
            test: false,
            exited: false,
            paused: false,
            holdout: false,
            variant_picks: {},
            challenges: [],
            queue: [],
            fired: [],
            modules_done: modulesDone,
            streak: null,
            streak_bridged: [],
            next_step_key: null,
            next_step_at: null,
            updated_at: now,
          },
          $setOnInsert: { created_at: now },
        },
        { upsert: true },
      );
    }

    // ── Fuera del curso ──
    for (const email of [ORPHAN_EMAIL, ADMIN_EMAIL]) {
      const user = await col('users').findOne({ email });
      if (!user) continue;
      log(`${user.names} (${email}) → fuera del curso y de Gen.ON`);
      await wipe(String(user._id), false);
    }

    // ── Demostraciones del programa (solo con --end-demos) ──
    const demos = await col('genon_demos').find({ program_id: programId }).toArray();
    if (demos.length && !process.argv.includes('--end-demos')) {
      log(
        `${demos.length} demostración(es) se conservan con sus participantes (--end-demos para terminarlas)`,
      );
    }
    for (const demo of process.argv.includes('--end-demos') ? demos : []) {
      const ids: string[] = (demo.participants || []).map((p: any) =>
        String(p.user_id),
      );
      const marked = (
        await col('users')
          .find({
            _id: {
              $in: ids
                .filter((id) => ObjectId.isValid(id))
                .map((id) => new ObjectId(id)),
            },
            seed_tag: 'genon-demo',
          })
          .project({ _id: 1 })
          .toArray()
      ).map((u) => String(u._id));
      log(
        `Demostración "${demo.name}" → se termina (${marked.length} participantes)`,
      );
      if (dryRun) continue;
      const vals = marked.flatMap(idVariants);
      await Promise.all([
        col('activityattendees').deleteMany({ user_id: { $in: vals } }),
        col('progress_events').deleteMany({ user_id: { $in: marked } }),
        col('UserAttemptsQuiz').deleteMany({ userId: { $in: marked } }),
        col('certificates').deleteMany({ userId: { $in: vals } }),
        col('useractivities').deleteMany({ user_id: { $in: vals } }),
        col('users').deleteMany({
          _id: { $in: marked.map((id) => new ObjectId(id)) },
          seed_tag: 'genon-demo',
        }),
        col('organizationusers').deleteMany({
          user_id: { $in: vals },
          seed_tag: 'genon-demo',
        }),
        col('courseattendees').deleteMany({ user_id: { $in: vals } }),
        col('engagement_messages').deleteMany({ user_id: { $in: marked } }),
        col('auth_links').deleteMany({ user_id: { $in: marked } }),
        col('genon_enrollments').deleteMany({ user_id: { $in: marked } }),
        col('genon_feedback').deleteMany({ user_id: { $in: marked } }),
      ]);
      await col('genon_demos').deleteOne({ _id: demo._id });
    }

    // Inscripciones de programas que ya no existen (borrados en pruebas anteriores)
    const programIds = (
      await col('genon_programs').find({}).project({ _id: 1 }).toArray()
    ).map((p) => String(p._id));
    const staleFilter = {
      event_id: EVENT_ID,
      program_id: { $nin: programIds },
    };
    log(
      `${await col('genon_enrollments').countDocuments(staleFilter)} inscripciones de programas borrados → se borran`,
    );
    if (!dryRun) await col('genon_enrollments').deleteMany(staleFilter);

    // La próxima pasada del cron segmenta y revisa los disparadores diarios hoy
    log(
      `Programa "${program.name}" (${program.mode}) → se vuelve a segmentar en la próxima pasada del cron`,
    );
    if (!dryRun) {
      await col('genon_programs').updateOne(
        { _id: program._id },
        { $set: { last_segmented_on: null } },
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
