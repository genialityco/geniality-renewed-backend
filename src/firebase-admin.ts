/* src/firebase-admin.ts */
import 'dotenv/config'; // Asegura que .env está cargado ANTES de leer process.env
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

type SA = admin.ServiceAccount;

function readJsonFile(p: string) {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

function normalizePrivateKey<T extends { private_key?: string }>(obj: T): T {
  if (obj && typeof obj.private_key === 'string') {
    // Corrige claves con \n escapados provenientes de variables de entorno
    obj.private_key = obj.private_key.replace(/\\n/g, '\n');
  }
  return obj;
}

function loadServiceAccount(): SA {
  // 1) JSON en variable de entorno
  const envJson = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (envJson && envJson !== 'undefined') {
    const parsed = JSON.parse(envJson);
    return normalizePrivateKey(parsed);
  }

  // 2) Base64 en variable de entorno (opcional)
  const envB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64?.trim();
  if (envB64) {
    const json = Buffer.from(envB64, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return normalizePrivateKey(parsed);
  }

  // 3) GOOGLE_APPLICATION_CREDENTIALS apunta a un archivo
  const gacPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gacPath && fs.existsSync(gacPath)) {
    const parsed = readJsonFile(gacPath);
    return normalizePrivateKey(parsed);
  }

  // 4) Archivo en la RAÍZ del proyecto (no en src). Usamos cwd para evitar dist/.
  const candidate = path.join(process.cwd(), 'firebase-sdk.json');
  if (fs.existsSync(candidate)) {
    const parsed = readJsonFile(candidate);
    return normalizePrivateKey(parsed);
  }

  throw new Error(
    'No se encontró ninguna credencial de Firebase: define FIREBASE_SERVICE_ACCOUNT (JSON), ' +
      'FIREBASE_SERVICE_ACCOUNT_B64 (base64), GOOGLE_APPLICATION_CREDENTIALS (ruta), o coloca firebase-sdk.json en la raíz del proyecto.',
  );
}

let alreadyInit = false;

function ensureFirebase() {
  if (!alreadyInit && !admin.apps.length) {
    const sa = loadServiceAccount();
    admin.initializeApp({
      credential: admin.credential.cert(sa),
    });
    alreadyInit = true;
  }
}

ensureFirebase();
export default admin;
