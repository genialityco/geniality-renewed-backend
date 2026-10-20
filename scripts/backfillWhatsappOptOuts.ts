import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Recupera las bajas de WhatsApp anteriores a `whatsapp_opt_out_at`.
 *
 * Con el consentimiento por defecto (WHATSAPP_CONSENT_DEFAULT), todo miembro
 * sin `whatsapp_opt_out_at` cuenta como aceptado. Antes de que existiera ese
 * campo, responder BAJA en un simulacro solo ponía `whatsapp_opt_in: false`,
 * que es indistinguible de "nunca lo activó": esas personas volverían a
 * recibir mensajes. Este script busca en las conversaciones de los simulacros
 * los mensajes de baja del estudiante y les fija `whatsapp_opt_out_at` con la
 * fecha del mensaje.
 *
 * No puede recuperar a quien desactivó WhatsApp desde su perfil antes de que
 * existiera el campo: ese cambio no dejó rastro.
 *
 * Uso:
 *   npx ts-node scripts/backfillWhatsappOptOuts.ts --dry-run   # solo reporta
 *   npx ts-node scripts/backfillWhatsappOptOuts.ts            # aplica cambios
 */

// Mismas palabras que PracticeEngineService (OPT_OUT_WORDS)
const OPT_OUT_WORDS = new Set(['baja', 'darme de baja', 'no mas mensajes']);

// Igual que normalizeText en ai-evaluations/practice-format
function normalizeText(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function backfillWhatsappOptOuts() {
  const dryRun = process.argv.includes('--dry-run');

  const uri =
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    'mongodb://localhost/geniality';
  await mongoose.connect(uri);
  console.log(
    `✅ Conectado a MongoDB${dryRun ? ' (DRY RUN, no se escribe nada)' : ''}`,
  );

  const db = mongoose.connection;
  const sessions = db.collection('practice_sessions');
  const orgUsers = db.collection('organizationusers');

  // Primera baja por membresía (usuario + organización)
  const optOutAt = new Map<
    string,
    { user_id: any; organization_id: any; at: Date }
  >();
  const cursor = sessions
    .find({ 'messages.role': 'user' })
    .project({ user_id: 1, organization_id: 1, messages: 1 });

  let scanned = 0;
  for await (const s of cursor) {
    scanned++;
    for (const m of s.messages || []) {
      if (m.role !== 'user') continue;
      if (!OPT_OUT_WORDS.has(normalizeText(m.content))) continue;
      const key = `${String(s.user_id)}|${String(s.organization_id)}`;
      const at = m.created_at ? new Date(m.created_at) : new Date();
      const prev = optOutAt.get(key);
      if (!prev || at < prev.at) {
        optOutAt.set(key, {
          user_id: s.user_id,
          organization_id: s.organization_id,
          at,
        });
      }
    }
  }
  console.log(
    `🔍 ${scanned} simulacros revisados, ${optOutAt.size} membresías con baja`,
  );

  const variants = (id: any) => {
    const raw = String(id);
    return mongoose.Types.ObjectId.isValid(raw)
      ? [raw, new mongoose.Types.ObjectId(raw)]
      : [raw];
  };

  let updated = 0;
  let alreadyMarked = 0;
  let notFound = 0;
  for (const { user_id, organization_id, at } of optOutAt.values()) {
    const filter = {
      user_id: { $in: variants(user_id) },
      organization_id: { $in: variants(organization_id) },
    };
    const doc = await orgUsers.findOne(filter, {
      projection: { whatsapp_opt_out_at: 1, whatsapp_opt_in_at: 1 },
    });
    if (!doc) {
      notFound++;
      continue;
    }
    // Ya tiene la baja registrada, o volvió a activarlo después de la baja
    if (
      doc.whatsapp_opt_out_at ||
      (doc.whatsapp_opt_in_at && new Date(doc.whatsapp_opt_in_at) > at)
    ) {
      alreadyMarked++;
      continue;
    }
    console.log(
      `  • user ${String(user_id)} · org ${String(organization_id)} · baja ${at.toISOString()}`,
    );
    if (!dryRun) {
      await orgUsers.updateOne(
        { _id: doc._id },
        {
          $set: {
            whatsapp_opt_in: false,
            whatsapp_opt_in_at: null,
            whatsapp_opt_out_at: at,
          },
        },
      );
    }
    updated++;
  }

  console.log(
    `${dryRun ? '🧪 Se marcarían' : '✅ Marcadas'} ${updated} bajas · ya registradas o reactivadas: ${alreadyMarked} · membresía no encontrada: ${notFound}`,
  );
  await mongoose.disconnect();
}

backfillWhatsappOptOuts().catch(async (error) => {
  console.error('❌ Error:', error);
  await mongoose.disconnect();
  process.exit(1);
});
