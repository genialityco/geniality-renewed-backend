import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Cambia los correos de los usuarios ficticios de la organización de prueba
 * de Gen.ON (genon.prueba+clave@example.com, que no sirven por el "+") por
 * su primer nombre: andres@prueba.com. Toca `users.email` y
 * `organizationusers.properties.email`. Solo usuarios de la semilla.
 *
 * Uso:
 *   npx ts-node scripts/fixGenOnTestEmails.ts --dry-run   # solo reporta
 *   npx ts-node scripts/fixGenOnTestEmails.ts             # aplica
 */

const ORG_ID = '6ada6d2ab4d306c546cb8e38';
const SEED_TAG = 'genon-prueba';

// Clave de la semilla → correo nuevo
const EMAILS: Record<string, string> = {
  abandono1: 'laura@prueba.com',
  abandono2: 'andres@prueba.com',
  inactivo1: 'camila@prueba.com',
  inactivo2: 'julian@prueba.com',
  activo_racha: 'valentina@prueba.com',
  activo_modulo: 'santiago@prueba.com',
  examen: 'daniela@prueba.com',
  graduado: 'felipe@prueba.com',
};

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost/geniality');
  const db = mongoose.connection;
  try {
    const { ObjectId } = mongoose.Types;
    const orgIds = [new ObjectId(ORG_ID), ORG_ID];
    const members = await db
      .collection('organizationusers')
      .find({ organization_id: { $in: orgIds }, seed_tag: SEED_TAG })
      .toArray();
    if (!members.length) throw new Error('La organización no tiene usuarios de la semilla.');

    const users = await db
      .collection('users')
      .find({ _id: { $in: members.map((m) => new ObjectId(String(m.user_id))) } })
      .toArray();
    const userById = new Map(users.map((u) => [String(u._id), u]));

    // Ningún usuario fuera de la semilla debe tener ya esos correos
    const taken = await db
      .collection('users')
      .find({ email: { $in: Object.values(EMAILS) }, seed_tag: { $ne: SEED_TAG } })
      .project({ email: 1 })
      .toArray();
    if (taken.length) {
      throw new Error(`Correos ya usados por otros usuarios: ${taken.map((u) => u.email).join(', ')}`);
    }

    for (const m of members) {
      const user = userById.get(String(m.user_id));
      const key = String(user?.uid || '').replace(`seed-${SEED_TAG}-`, '');
      const email = EMAILS[key];
      if (!user || !email) {
        console.log(`Se omite ${m.properties?.email || m._id}: no es un usuario de la semilla`);
        continue;
      }
      console.log(`${dryRun ? '[dry-run] ' : ''}${user.email} → ${email}`);
      if (dryRun) continue;
      await db.collection('users').updateOne({ _id: user._id }, { $set: { email, updatedAt: new Date() } });
      await db
        .collection('organizationusers')
        .updateOne({ _id: m._id }, { $set: { 'properties.email': email, updated_at: new Date() } });
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
