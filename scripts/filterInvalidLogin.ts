/* scripts/filterInvalidLogin.ts */
import * as fs from 'fs';
import * as path from 'path';

type Row = {
  organization_id: string;
  user_mongo_id: string;
  user_uid_in_mongo?: string;
  firebase_uid?: string;
  email_checked?: string;
  email_source?: string;
  email_field?: string;
  password_source?: string;
  password_field?: string;
  password_masked?: string;
  verify_status:
    | 'OK'
    | 'INVALID_PASSWORD'
    | 'USER_DISABLED'
    | 'EMAIL_NOT_FOUND'
    | 'MISSING_EMAIL'
    | 'MISSING_PASSWORD'
    | 'PHONE_ONLY'
    | 'ERROR';
  action: 'none' | 'would_update' | 'updated' | 'created' | 'skipped';
  notes?: string;
};

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

async function main() {
  const inArg = process.argv.find((a) => a.startsWith('--in='))?.split('=')[1];
  const inputPath = path.resolve(
    process.cwd(),
    inArg || 'auth-audit-report.json',
  );

  if (!fs.existsSync(inputPath)) {
    console.error(`No se encontró el archivo de entrada: ${inputPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(inputPath, 'utf8');
  const rows: Row[] = JSON.parse(raw);

  const filtered = rows.filter((r) =>
    /(^|[ \t|])INVALID_LOGIN_CREDENTIALS([ \t|]|$)/i.test(r.notes ?? ''),
  );

  const outJson = path.resolve(process.cwd(), 'auth-invalid-login.json');
  const outCsv = path.resolve(process.cwd(), 'auth-invalid-login.csv');

  fs.writeFileSync(outJson, JSON.stringify(filtered, null, 2), 'utf8');
  fs.writeFileSync(outCsv, toCSV(filtered), 'utf8');

  console.log(`Filtrados: ${filtered.length}`);
  console.log(`Generados:
  - ${outJson}
  - ${outCsv}`);
}

main();
