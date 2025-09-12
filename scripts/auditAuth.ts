/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * scripts/auditAuth.ts
 *
 * Auditoría y corrección opcional de credenciales de usuarios contra Firebase.
 *
 * Uso:
 *  - Auditoría (sin cambios):      ts-node scripts/auditAuth.ts
 *  - Aplicar fixes (reset pass):    ts-node scripts/auditAuth.ts --apply
 *  - Filtrar por organización:      ts-node scripts/auditAuth.ts --org=<organization_id>
 *  - (Opc) Reset a ID en MISSING_PASSWORD: ts-node scripts/auditAuth.ts --reset-missing-to-id --apply
 *  - (Opc) Crear los EMAIL_NOT_FOUND:      ts-node scripts/auditAuth.ts --create-missing --apply
 *
 * Requisitos de entorno:
 *  - MONGO_URI="mongodb+srv://..."
 *  - FIREBASE_API_KEY="..."   (Web API key del proyecto para verifyPassword)
 *  - FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}'  (JSON inline)  **o**
 *  - GOOGLE_APPLICATION_CREDENTIALS="/ruta/service-account.json"
 *
 * Salidas:
 *  - ./auth-audit-report.json         (detalle por usuario)
 *  - ./auth-audit-report.csv          (detalle CSV)
 *  - ./auth-audit-summary-by-org.json (resumen por organización)
 *  - ./auth-audit-email-not-found.json
 *  - ./auth-audit-missing-email.json
 *  - ./auth-audit-missing-password.json
 *  - ./auth-audit-phone-only.json
 */

import 'dotenv/config';
import mongoose, { Schema, Types } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';
import admin from 'firebase-admin';

// -------------------- Tipos de documentos ligeros --------------------
type OrgUserDoc = {
  _id: string;
  properties: any;
  rol_id?: string | null;
  organization_id: string;
  user_id: Types.ObjectId | string;
  payment_plan_id?: Types.ObjectId | string | null;
};

type UserDoc = {
  _id: string;
  uid: string;
  names?: string;
  email?: string;
  phone?: string;
  sessionTokens?: Array<{ token: string; createdAt: string }>;
};

// -------------------- Flags / entorno --------------------
const MONGO_URI = process.env.MONGO_URI!;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY!;
const APPLY_CHANGES = process.argv.includes('--apply');
const ORG_FILTER =
  process.argv.find((a) => a.startsWith('--org='))?.split('=')[1] || null;

// Opcionales
const RESET_MISSING_PASSWORD_TO_ID = process.argv.includes(
  '--reset-missing-to-id',
);
const CREATE_MISSING = process.argv.includes('--create-missing');

if (!MONGO_URI) throw new Error('Falta MONGO_URI');
if (!FIREBASE_API_KEY) throw new Error('Falta FIREBASE_API_KEY');

// -------------------- Helpers de diagnóstico --------------------
function mask(str: string, show = 8) {
  if (!str) return '';
  if (str.length <= show) return str;
  return `${str.slice(0, show)}${'*'.repeat(Math.max(0, str.length - show))}`;
}

function parseMongoInfo(uri: string) {
  try {
    const u = new URL(uri.replace('mongodb+srv://', 'https://'));
    const db = (u.pathname || '').replace(/^\//, '') || '(default-db)';
    return { host: u.host, db };
  } catch {
    return { host: '(desconocido)', db: '(desconocido)' };
  }
}

type SAInfo = {
  project_id?: string;
  client_email?: string;
  client_id?: string;
  private_key_id?: string;
  sa_path?: string;
};
function readServiceAccountInfo(): SAInfo | null {
  // 1) JSON inline en FIREBASE_SERVICE_ACCOUNT
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const json = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      return {
        project_id: json.project_id,
        client_email: json.client_email,
        client_id: json.client_id,
        private_key_id: json.private_key_id
          ? `${String(json.private_key_id).slice(0, 8)}…`
          : undefined,
        sa_path: '(env:FIREBASE_SERVICE_ACCOUNT)',
      };
    } catch {
      return { sa_path: '(env:FIREBASE_SERVICE_ACCOUNT inválido)' };
    }
  }
  // 2) Ruta a archivo en GOOGLE_APPLICATION_CREDENTIALS
  try {
    const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!p) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const json = JSON.parse(raw);
    return {
      project_id: json.project_id,
      client_email: json.client_email,
      client_id: json.client_id,
      private_key_id: json.private_key_id
        ? `${json.private_key_id.slice(0, 8)}…`
        : undefined,
      sa_path: p,
    };
  } catch {
    return null;
  }
}

// -------------------- Firebase Admin (carga robusta) --------------------
let inferredProjectId: string | undefined;

if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: svc.project_id,
          clientEmail: svc.client_email,
          privateKey: svc.private_key?.replace(/\\n/g, '\n'),
        }),
        projectId: svc.project_id,
      });
      inferredProjectId = svc.project_id;
    } catch (e) {
      console.error('No se pudo parsear FIREBASE_SERVICE_ACCOUNT:', e);
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
    }
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  } else {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
}

// Intenta deducir projectId real del Admin SDK
inferredProjectId =
  inferredProjectId ||
  (admin.app().options as any)?.projectId ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT;

// -------------------- Modelos Mongoose (ligeros) --------------------
const UserSchema = new Schema<UserDoc>(
  {
    uid: { type: String, required: true, unique: true },
    names: String,
    email: String,
    phone: String,
    sessionTokens: [
      {
        token: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { collection: 'users', timestamps: true },
);

const OrganizationUserSchema = new Schema<OrgUserDoc>(
  {
    properties: Schema.Types.Mixed,
    rol_id: { type: String, default: null },
    organization_id: { type: String, required: true },
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    payment_plan_id: { type: Schema.Types.ObjectId, ref: 'PaymentPlan' },
  },
  {
    collection: 'organizationusers',
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  },
);

const UserModel = mongoose.model<UserDoc>('User', UserSchema);
const OrganizationUserModel = mongoose.model<OrgUserDoc>(
  'OrganizationUser',
  OrganizationUserSchema,
);

// -------------------- Utilidades de extracción --------------------
function cleanEmail(e?: string | null) {
  return (e || '').trim().toLowerCase();
}

function normalizeDigits(s?: string | number | null) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\D+/g, '');
}

type EmailPick = {
  value: string;
  source: 'properties' | 'user' | '';
  field?: string;
};
function pickEmailSource(props: any, userEmail?: string | null): EmailPick {
  const candidates: Array<{ val?: any; field: string }> = [
    { val: props?.email, field: 'properties.email' },
    { val: props?.correo, field: 'properties.correo' },
    { val: props?.mail, field: 'properties.mail' },
    { val: props?.correo_electronico, field: 'properties.correo_electronico' },
    { val: props?.Email, field: 'properties.Email' },
    { val: props?.userEmail, field: 'properties.userEmail' },
    { val: props?.username, field: 'properties.username' },
  ];
  for (const c of candidates) {
    if (typeof c.val === 'string' && c.val.includes('@')) {
      return { value: cleanEmail(c.val), source: 'properties', field: c.field };
    }
  }
  if (userEmail && userEmail.includes('@')) {
    return {
      value: cleanEmail(userEmail),
      source: 'user',
      field: 'users.email',
    };
  }
  return { value: '', source: '', field: undefined };
}

type PassPick = {
  value: string | null;
  source: 'document-id' | 'password' | null;
  field?: string;
};
function pickPasswordSource(props: any): PassPick {
  // Documento como password (normalizado a dígitos)
  const docCandidates: Array<{ val?: any; field: string }> = [
    { val: props?.ID, field: 'properties.ID' },
    { val: props?.Id, field: 'properties.Id' },
    { val: props?.id, field: 'properties.id' },
    { val: props?.documento, field: 'properties.documento' },
    { val: props?.doc, field: 'properties.doc' },
    { val: props?.dni, field: 'properties.dni' },
    { val: props?.cedula, field: 'properties.cedula' },
    { val: props?.cédula, field: 'properties.cédula' },
    { val: props?.rut, field: 'properties.rut' },
    { val: props?.nit, field: 'properties.nit' },
    { val: props?.identificacion, field: 'properties.identificacion' },
    { val: props?.identificación, field: 'properties.identificación' },
  ];
  for (const c of docCandidates) {
    const onlyDigits = normalizeDigits(c.val);
    if (onlyDigits.length >= 6) {
      return { value: onlyDigits, source: 'document-id', field: c.field };
    }
  }

  // Password literal en properties
  const passCandidates: Array<{ val?: any; field: string }> = [
    { val: props?.password, field: 'properties.password' },
    { val: props?.contrasena, field: 'properties.contrasena' },
    { val: props?.contraseña, field: 'properties.contraseña' },
    { val: props?.pass, field: 'properties.pass' },
    { val: props?.clave, field: 'properties.clave' },
  ];
  for (const c of passCandidates) {
    if (typeof c.val === 'string' && c.val.trim().length >= 6) {
      return { value: c.val.trim(), source: 'password', field: c.field };
    }
  }

  return { value: null, source: null, field: undefined };
}

function maskPassword(pw?: string | null) {
  if (!pw) return '';
  if (pw.length <= 2) return '*'.repeat(pw.length);
  return '*'.repeat(Math.max(0, pw.length - 2)) + pw.slice(-2);
}

// -------------------- Verificación REST (no persiste sesión) --------------------
async function verifyWithFirebase(email: string, password: string) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const data: any = await res.json();
  if (!res.ok) {
    const code = data?.error?.message || 'UNKNOWN_ERROR';
    const reason = Array.isArray(data?.error?.errors)
      ? data.error.errors.map((e: any) => e.message).join(';')
      : '';
    throw new Error(code + (reason ? ` | ${reason}` : ''));
  }
  return data as {
    idToken: string;
    localId: string; // uid
    email: string;
    registered: boolean;
    displayName?: string;
    expiresIn: string;
    refreshToken: string;
  };
}

// -------------------- Normalización de errores Firebase REST --------------------
function mapFirebaseErrorToStatus(
  msg: string,
): 'INVALID_PASSWORD' | 'USER_DISABLED' | 'EMAIL_NOT_FOUND' | 'ERROR' {
  const m = (msg || '').toUpperCase();
  if (m.includes('INVALID_PASSWORD')) return 'INVALID_PASSWORD';
  if (m.includes('INVALID_LOGIN_CREDENTIALS')) return 'INVALID_PASSWORD'; // mapea al mismo caso
  if (m.includes('USER_DISABLED')) return 'USER_DISABLED';
  if (m.includes('EMAIL_NOT_FOUND')) return 'EMAIL_NOT_FOUND';
  return 'ERROR';
}

// -------------------- Tipo de fila de reporte --------------------
type VerifyStatus =
  | 'OK'
  | 'INVALID_PASSWORD'
  | 'USER_DISABLED'
  | 'EMAIL_NOT_FOUND'
  | 'MISSING_EMAIL'
  | 'MISSING_PASSWORD'
  | 'PHONE_ONLY'
  | 'ERROR';

type Row = {
  organization_id: string;
  user_mongo_id: string;
  user_uid_in_mongo?: string;
  firebase_uid?: string;
  email_checked?: string;
  email_source?: string; // 'properties' | 'user'
  email_field?: string; // campo exacto (p.ej. properties.correo)
  password_source?: string; // 'document-id' | 'password'
  password_field?: string; // campo exacto (p.ej. properties.ID)
  password_masked?: string;
  verify_status: VerifyStatus;
  action: 'none' | 'would_update' | 'updated' | 'created' | 'skipped';
  notes?: string;
};

// -------------------- CSV --------------------
function toCSV(rows: Row[]) {
  const headers = [
    'organization_id',
    'user_mongo_id',
    'user_uid_in_mongo',
    'firebase_uid',
    'email_checked',
    'email_source',
    'email_field',
    'password_source',
    'password_field',
    'password_masked',
    'verify_status',
    'action',
    'notes',
  ];
  const esc = (v: any) => {
    const s = (v ?? '').toString();
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => esc((r as any)[h])).join(',')),
  ].join('\n');
}

// -------------------- Main --------------------
async function main() {
  // -------- Banner de diagnóstico --------
  const sa = readServiceAccountInfo();
  const mongoInfo = parseMongoInfo(MONGO_URI);
  console.log('================= DIAGNÓSTICO DE CONEXIONES =================');
  console.log(`MongoDB -> host: ${mongoInfo.host} | db: ${mongoInfo.db}`);
  console.log(`Firebase Admin (service account):`);
  console.log(
    `  project_id: ${inferredProjectId ?? sa?.project_id ?? '(desconocido)'} | client_email: ${sa?.client_email ?? '(desconocido)'} | source: ${sa?.sa_path ?? '(ADC / no set)'}`,
  );
  console.log(
    `Firebase REST API key: ${mask(FIREBASE_API_KEY, 8)} (len=${FIREBASE_API_KEY.length})`,
  );
  console.log(
    '================================================================\n',
  );

  console.log(
    `\n=== Audit Auth ${APPLY_CHANGES ? '(APPLY MODE)' : '(DRY RUN)'} ===`,
  );
  console.log(`Filtro organización: ${ORG_FILTER ?? '(ninguno)'}\n`);

  await mongoose.connect(MONGO_URI);
  console.log('Mongo conectado');

  // Preflight Firebase (ayuda a detectar proyecto incorrecto)
  let preflightCount = 0;
  try {
    const pre = await admin.auth().listUsers(1);
    preflightCount = pre.users.length;
    console.log(
      `Firebase preflight: usuarios visibles en este proyecto ~${pre.users.length >= 1 ? '>=1' : '0'}`,
    );
  } catch (e) {
    console.log(
      'Advertencia: no pude listar usuarios Firebase (revisa credenciales del service account).',
    );
  }

  // Traer OrgUsers sin populate y luego "join" manual con Users
  const filter: any = {};
  if (ORG_FILTER) filter.organization_id = ORG_FILTER;

  const orgUsers = await OrganizationUserModel.find(filter).lean();
  console.log(`Registros organization-users leídos: ${orgUsers.length}`);

  const userIds = orgUsers
    .map((o) =>
      typeof o.user_id === 'string'
        ? o.user_id
        : (o.user_id as any)?.toString(),
    )
    .filter((v): v is string => !!v);

  const users = await UserModel.find({ _id: { $in: userIds } }).lean();
  const userById = new Map(users.map((u) => [u._id.toString(), u]));

  const rows: Row[] = [];

  // Contadores de diagnóstico
  let mismatch_admin_ok_rest_not_found = 0;

  for (const org of orgUsers) {
    const user = userById.get(
      typeof org.user_id === 'string'
        ? org.user_id
        : (org.user_id as any)?.toString(),
    );

    // Extraer email (y de dónde)
    const emailPick = pickEmailSource(org.properties, user?.email ?? '');
    const email = emailPick.value;

    // Extraer password candidata (y de dónde)
    const passPick = pickPasswordSource(org.properties);
    const passwordCandidate = passPick.value;

    // Extraer teléfono (útil para Phone Auth)
    const phoneFromProps =
      org?.properties?.phone || org?.properties?.telefono || user?.phone || '';

    const row: Row = {
      organization_id: org.organization_id,
      user_mongo_id: user?._id || String(org.user_id),
      user_uid_in_mongo: user?.uid,
      email_checked: email || '',
      email_source: emailPick.source || '',
      email_field: emailPick.field || '',
      password_source: passPick.source || '',
      password_field: passPick.field || '',
      password_masked: maskPassword(passwordCandidate),
      verify_status: 'ERROR',
      action: 'none',
      notes: '',
    };

    // 1) Clasificación temprana por faltantes
    if (!email) {
      if (phoneFromProps) {
        row.verify_status = 'PHONE_ONLY';
        row.notes = 'Usuario con teléfono; no hay email (posible Phone Auth).';
      } else {
        row.verify_status = 'MISSING_EMAIL';
        row.notes = 'Falta email en properties/users.';
      }
      rows.push(row);
      continue;
    }

    // ¿Existe en Firebase por email? (Admin SDK)
    let fbUser: admin.auth.UserRecord | null = null;
    try {
      fbUser = await admin.auth().getUserByEmail(email);
      row.firebase_uid = fbUser.uid;
    } catch {
      // No existe en Firebase (Admin)
      if (!passwordCandidate) {
        row.verify_status = 'EMAIL_NOT_FOUND';
        row.notes =
          'Email no existe en Firebase (Admin) y no hay contraseña candidata para crearlo/verificar.';
        rows.push(row);
        continue;
      } else {
        // Posibilidad de crear
        row.verify_status = 'EMAIL_NOT_FOUND';
        row.notes = 'Email no existe en Firebase (Admin).';
        if (CREATE_MISSING && APPLY_CHANGES) {
          try {
            const created = await admin
              .auth()
              .createUser({ email, password: passwordCandidate });
            row.firebase_uid = created.uid;
            row.action = 'created';
            row.notes += ' | Usuario creado en Firebase.';
            fbUser = created as unknown as admin.auth.UserRecord;
          } catch (err: any) {
            row.action = 'skipped';
            row.notes += ` | Fallo createUser: ${err?.message || err}`;
            rows.push(row);
            continue;
          }
        } else if (CREATE_MISSING && !APPLY_CHANGES) {
          row.action = 'would_update';
          row.notes += ' | Dry-run: se crearía usuario en Firebase.';
          // seguimos a verificar login si más adelante hubiera fbUser
        } else {
          rows.push(row);
          continue;
        }
      }
    }

    // Si llegaste aquí y NO tienes password candidata:
    if (!passwordCandidate) {
      row.verify_status = 'MISSING_PASSWORD';
      row.notes =
        'Existe en Firebase (Admin), pero no hay contraseña candidata (ID/password) en properties.';
      // Reset opcional con ID SOLO si el origen es EXACTAMENTE properties.ID
      if (
        RESET_MISSING_PASSWORD_TO_ID &&
        fbUser &&
        passPick.source === 'document-id' &&
        passPick.field === 'properties.ID'
      ) {
        try {
          if (APPLY_CHANGES) {
            await admin
              .auth()
              .updateUser(fbUser.uid, { password: passPick.value! });
            row.action = 'updated';
            row.notes +=
              ' | Password seteada usando properties.ID (ID normalizado).';
          } else {
            row.action = 'would_update';
            row.notes +=
              ' | Dry-run: se setearía password usando properties.ID.';
          }
        } catch (err: any) {
          row.action = 'skipped';
          row.notes += ` | Fallo updateUser: ${err?.message || err}`;
        }
      }
      rows.push(row);
      continue;
    }

    // 2) Intento de login REST (con API key)
    try {
      const res = await verifyWithFirebase(email, passwordCandidate);
      row.verify_status = 'OK';
      if (user?.uid && user.uid !== res.localId) {
        row.notes = `UID Mongo (${user.uid}) difiere de Firebase (${res.localId}).`;
      }
      rows.push(row);
      continue;
    } catch (e: any) {
      const msg = (e?.message || 'ERROR').toString();
      const mapped = mapFirebaseErrorToStatus(msg);
      row.verify_status = mapped;

      if (mapped === 'EMAIL_NOT_FOUND') {
        // Caso clave: Admin lo encuentra, pero REST dice EMAIL_NOT_FOUND -> MISMATCH de proyecto/API key
        row.notes =
          (row.notes ? row.notes + ' | ' : '') +
          'Mismatch probable: Admin encontró el usuario, pero REST (API key) devolvió EMAIL_NOT_FOUND. Revisa que FIREBASE_API_KEY sea del mismo proyecto que el service account.';
        mismatch_admin_ok_rest_not_found++;
      } else {
        row.notes = (row.notes ? row.notes + ' | ' : '') + msg;
      }
    }

    // 3) Corrección opcional (reset pass) para INVALID_PASSWORD
    if (row.verify_status === 'INVALID_PASSWORD' && fbUser) {
      // Solo resetear si la candidata proviene EXACTAMENTE de properties.ID
      if (
        passPick.source === 'document-id' &&
        passPick.field === 'properties.ID' &&
        passPick.value
      ) {
        if (APPLY_CHANGES) {
          try {
            await admin
              .auth()
              .updateUser(fbUser.uid, { password: passPick.value });
            row.action = 'updated';
            row.notes =
              (row.notes ? row.notes + ' | ' : '') +
              'Password reseteada usando properties.ID.';
          } catch (err: any) {
            row.action = 'skipped';
            row.notes =
              (row.notes ? row.notes + ' | ' : '') +
              `Fallo updateUser: ${err?.message || err}`;
          }
        } else {
          row.action = 'would_update';
          row.notes =
            (row.notes ? row.notes + ' | ' : '') +
            'Dry-run: se resetearía password usando properties.ID.';
        }
      } else {
        row.action = 'skipped';
        row.notes =
          (row.notes ? row.notes + ' | ' : '') +
          'No se resetea: la contraseña candidata no proviene de properties.ID.';
      }
    }

    rows.push(row);
  }

  // -------------------- Salidas --------------------
  const outJson = path.resolve(process.cwd(), 'auth-audit-report.json');
  const outCsv = path.resolve(process.cwd(), 'auth-audit-report.csv');
  fs.writeFileSync(outJson, JSON.stringify(rows, null, 2), 'utf8');
  fs.writeFileSync(outCsv, toCSV(rows), 'utf8');

  // Resumen por estado (global)
  const totals = rows.reduce(
    (acc, r) => {
      acc[r.verify_status] = (acc[r.verify_status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  console.log('\nResumen verificación por estado:', totals);

  // Resumen por organización
  const perOrg = rows.reduce(
    (acc, r) => {
      const k = r.organization_id || 'N/A';
      if (!acc[k]) {
        acc[k] = {
          OK: 0,
          INVALID_PASSWORD: 0,
          USER_DISABLED: 0,
          EMAIL_NOT_FOUND: 0,
          MISSING_EMAIL: 0,
          MISSING_PASSWORD: 0,
          PHONE_ONLY: 0,
          ERROR: 0,
        };
      }
      acc[k][r.verify_status] = (acc[k][r.verify_status] || 0) + 1;
      return acc;
    },
    {} as Record<string, Record<string, number>>,
  );

  const perOrgOut = path.resolve(
    process.cwd(),
    'auth-audit-summary-by-org.json',
  );
  fs.writeFileSync(perOrgOut, JSON.stringify(perOrg, null, 2), 'utf8');

  // Archivos segmentados (para revisar rápido)
  const seg = (status: VerifyStatus, file: string) => {
    const list = rows.filter((r) => r.verify_status === status);
    fs.writeFileSync(
      path.resolve(process.cwd(), file),
      JSON.stringify(list, null, 2),
      'utf8',
    );
  };
  seg('EMAIL_NOT_FOUND', 'auth-audit-email-not-found.json');
  seg('MISSING_EMAIL', 'auth-audit-missing-email.json');
  seg('MISSING_PASSWORD', 'auth-audit-missing-password.json');
  seg('PHONE_ONLY', 'auth-audit-phone-only.json');

  // -------- Resumen de mismatch Admin vs REST --------
  console.log('\n=== Diagnóstico Adicional ===');
  console.log(
    `Usuarios con mismatch (Admin SI encuentra, REST dice EMAIL_NOT_FOUND): ${mismatch_admin_ok_rest_not_found}`,
  );
  if (mismatch_admin_ok_rest_not_found > 0) {
    console.log(
      `\n⚠️  Probable API key incorrecta o de otro proyecto.\n` +
        `   - Admin SDK (service account) proyecto: ${inferredProjectId ?? '(desconocido)'}\n` +
        `   - API key (enmascarada): ${mask(FIREBASE_API_KEY, 8)} (len=${FIREBASE_API_KEY.length})\n` +
        `   - Verifica que la Web API key pertenezca al MISMO proyecto de Firebase que el service account.\n` +
        `   - En consola de Firebase: Configuración del proyecto → General → Tus apps (Web) → "Clave de API".\n`,
    );
  }

  console.log(`\nReportes guardados:
  - ${outJson}
  - ${outCsv}
  - ${perOrgOut}
  - ${path.resolve(process.cwd(), 'auth-audit-email-not-found.json')}
  - ${path.resolve(process.cwd(), 'auth-audit-missing-email.json')}
  - ${path.resolve(process.cwd(), 'auth-audit-missing-password.json')}
  - ${path.resolve(process.cwd(), 'auth-audit-phone-only.json')}
`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('ERROR general:', err);
  process.exit(1);
});
