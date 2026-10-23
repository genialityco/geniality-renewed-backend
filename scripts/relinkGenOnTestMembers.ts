import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Organización de prueba de Gen.ON: vuelve a enlazar cada membresía de la
 * semilla con su usuario de la semilla (el que tiene el avance del curso y la
 * inscripción de Gen.ON) cuando quedó apuntando a otro usuario, y deja con
 * consentimiento de WhatsApp a todos los miembros de prueba. No toca a los
 * administradores reales.
 *
 * Uso:
 *   npx ts-node scripts/relinkGenOnTestMembers.ts --dry-run   # solo reporta
 *   npx ts-node scripts/relinkGenOnTestMembers.ts             # aplica
 */

const ORG_ID = '6ada6d2ab4d306c546cb8e38';
const SEED_TAG = 'genon-prueba';
// Administradores reales copiados de ACE: no se tocan
const REAL_ADMINS = ['procaps@geniality.com.co'];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const tag = dryRun ? '[dry-run] ' : '';
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost/geniality');
  const db = mongoose.connection;
  try {
    const { ObjectId } = mongoose.Types;
    const members = await db
      .collection('organizationusers')
      .find({ organization_id: { $in: [new ObjectId(ORG_ID), ORG_ID] } })
      .toArray();
    const seedUsers = await db.collection('users').find({ seed_tag: SEED_TAG }).toArray();
    const seedByEmail = new Map(seedUsers.map((u) => [String(u.email).toLowerCase(), u]));
    const linked = new Set(members.map((m) => String(m.user_id)));

    for (const m of members) {
      const email = String(m.properties?.email || '').toLowerCase();
      if (REAL_ADMINS.includes(email)) continue;
      const $set: Record<string, any> = {};

      const seedUser = m.seed_tag === SEED_TAG ? seedByEmail.get(email) : undefined;
      if (seedUser && String(seedUser._id) !== String(m.user_id)) {
        if (linked.has(String(seedUser._id))) {
          console.log(`Se omite ${email}: su usuario de la semilla ya tiene otra membresía`);
        } else {
          console.log(`${tag}${email}: membresía ${String(m.user_id)} → usuario de la semilla ${String(seedUser._id)}`);
          $set.user_id = seedUser._id;
        }
      }
      if (m.whatsapp_opt_in !== true || m.whatsapp_opt_out_at) {
        console.log(`${tag}${email}: consentimiento de WhatsApp activado`);
        Object.assign($set, {
          whatsapp_opt_in: true,
          whatsapp_opt_in_at: new Date(),
          whatsapp_opt_out_at: null,
        });
      }
      if (!dryRun && Object.keys($set).length) {
        await db
          .collection('organizationusers')
          .updateOne({ _id: m._id }, { $set: { ...$set, updated_at: new Date() } });
      }
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
