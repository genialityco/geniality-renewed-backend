/* src/firebase-admin.ts */
import 'dotenv/config'; // carga .env primero
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
    obj.private_key = obj.private_key.replace(/\\n/g, '\n');
  }
  return obj;
}

function loadServiceAccount(): SA {
  // 1) JSON inline en env
  const envJson = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (envJson && envJson !== 'undefined') {
    const parsed = JSON.parse(envJson);
    return normalizePrivateKey(parsed);
  }

  // 2) Base64 en env (opcional)
  const envB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64?.trim();
  if (envB64) {
    const json = Buffer.from(envB64, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return normalizePrivateKey(parsed);
  }

  // 3) GOOGLE_APPLICATION_CREDENTIALS (ruta a archivo)
  const gacPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gacPath && fs.existsSync(gacPath)) {
    const parsed = readJsonFile(gacPath);
    return normalizePrivateKey(parsed);
  }

  // 4) Archivo firebase-sdk.json en la raíz del proyecto
  const candidate = path.join(process.cwd(), 'firebase-sdk.json');
  if (fs.existsSync(candidate)) {
    const parsed = readJsonFile(candidate);
    return normalizePrivateKey(parsed);
  }

  throw new Error(
    'No se encontraron credenciales Firebase. Define FIREBASE_SERVICE_ACCOUNT (JSON), ' +
      'FIREBASE_SERVICE_ACCOUNT_B64 (base64), GOOGLE_APPLICATION_CREDENTIALS (ruta) o coloca firebase-sdk.json en la raíz.',
  );
}

function getProjectId(sa: any): string | undefined {
  return process.env.FIREBASE_PROJECT_ID || sa.project_id;
}

function getDatabaseURL(projectId?: string): string | undefined {
  return (
    process.env.FIREBASE_DATABASE_URL ||
    (projectId ? `https://${projectId}-default-rtdb.firebaseio.com` : undefined)
  );
}

function getStorageBucket(projectId?: string): string | undefined {
  // OJO: el bucket real es "<project-id>.appspot.com"
  return (
    process.env.FIREBASE_STORAGE_BUCKET ||
    (projectId ? `${projectId}.appspot.com` : undefined)
  );
}

let alreadyInit = false;

function ensureFirebase() {
  if (!alreadyInit && !admin.apps.length) {
    const sa = loadServiceAccount();
    const projectId = getProjectId(sa);
    const databaseURL = getDatabaseURL(projectId);
    const storageBucket = getStorageBucket(projectId);

    if (!databaseURL) {
      throw new Error(
        `FIREBASE_DATABASE_URL no está configurado y no se pudo derivar del projectId (${projectId ?? 'N/A'}).`,
      );
    }

    admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId,
      databaseURL,
      storageBucket,
    });

    alreadyInit = true;
  }
}

ensureFirebase();
export default admin;
