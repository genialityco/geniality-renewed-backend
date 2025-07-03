/* eslint-disable @typescript-eslint/no-require-imports */
// src/firebase-admin.ts
import * as admin from 'firebase-admin';
import * as path from 'path';
import * as fs from 'fs';

let serviceAccount: any;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Toma la variable de entorno en producción (JSON en una sola línea)
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  // Toma el archivo local en desarrollo
  const serviceAccountPath = path.resolve(__dirname, '../firebase-sdk.json');
  // Para evitar error si no existe, verifica existencia del archivo
  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(
      'No se encontró firebase-sdk.json y no se configuró la variable FIREBASE_SERVICE_ACCOUNT',
    );
  }
  serviceAccount = require(serviceAccountPath);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

export default admin;
