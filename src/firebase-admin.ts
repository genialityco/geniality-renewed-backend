// src/firebase-admin.ts
import * as admin from 'firebase-admin';
import * as path from 'path';

const serviceAccountPath = path.resolve(__dirname, '../firebase-sdk.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require(serviceAccountPath)),
  });
}

export default admin;
