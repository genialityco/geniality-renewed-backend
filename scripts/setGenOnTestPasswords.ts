import * as mongoose from 'mongoose';
import admin from '../src/firebase-admin';

/**
 * Deja la misma contraseña a los usuarios de prueba de "[PRUEBA] Gen.ON"
 * (los de resetGenOnTestOrg.ts) para poder entrar como cada uno. Si el
 * usuario no tiene cuenta en Firebase, se la crea con el uid que ya tiene en
 * la base (así el inicio de sesión lo encuentra). Si su correo ya es de otra
 * cuenta de Firebase con otro uid, no lo toca y lo reporta.
 *
 * Uso:
 *   npx ts-node scripts/setGenOnTestPasswords.ts --dry-run   # solo reporta
 *   npx ts-node scripts/setGenOnTestPasswords.ts             # aplica
 */

const PASSWORD = '123456';
const EMAILS = [
  'laura@prueba.com',
  'abandono2@example.com',
  'abandono3@example.com',
  'camila@prueba.com',
  'julian@prueba.com',
  'valentina@prueba.com',
  'santiago@prueba.com',
  'daniela@prueba.com',
  'felipe@prueba.com',
];

const isNotFound = (error: any) => error?.code === 'auth/user-not-found';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const log = (msg: string) => console.log(`${dryRun ? '[dry-run] ' : ''}${msg}`);
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost/geniality');
  const auth = admin.auth();
  try {
    for (const email of EMAILS) {
      const user = await mongoose.connection.collection('users').findOne({ email });
      if (!user?.uid) {
        log(`${email}: no existe en la base (o no tiene uid), se omite`);
        continue;
      }
      const uid = String(user.uid);
      const byUid = await auth.getUser(uid).catch((e) => (isNotFound(e) ? null : Promise.reject(e)));
      if (byUid) {
        // Las cuentas creadas al entrar con un enlace de acceso directo no
        // tienen correo: sin él no se puede iniciar sesión con contraseña
        if ((byUid.email || '').toLowerCase() !== email) {
          const owner = await auth.getUserByEmail(email).catch((e) => (isNotFound(e) ? null : Promise.reject(e)));
          if (owner && owner.uid !== uid) {
            log(
              `${user.names} (${email}): solo cambia la contraseña. El correo es de otra cuenta de Firebase (uid ${owner.uid}), no se le asigna`,
            );
            if (!dryRun) await auth.updateUser(uid, { password: PASSWORD });
            continue;
          }
          log(`${user.names} (${email}): se le asigna el correo (no tenía) y cambia la contraseña`);
          if (!dryRun) await auth.updateUser(uid, { email, password: PASSWORD });
          continue;
        }
        log(`${user.names} (${email}): cambia la contraseña`);
        if (!dryRun) await auth.updateUser(uid, { password: PASSWORD });
        continue;
      }
      const byEmail = await auth.getUserByEmail(email).catch((e) => (isNotFound(e) ? null : Promise.reject(e)));
      if (byEmail) {
        log(
          `${user.names} (${email}): NO SE TOCA. El correo es de otra cuenta de Firebase (uid ${byEmail.uid}) y en la base tiene el uid ${uid}`,
        );
        continue;
      }
      log(`${user.names} (${email}): no tiene cuenta en Firebase, se crea con uid ${uid}`);
      if (!dryRun) {
        await auth.createUser({ uid, email, password: PASSWORD, displayName: user.names || undefined });
      }
    }
  } finally {
    await mongoose.disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
