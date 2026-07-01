import admin from '../firebase-admin';

export interface UploadedFileResult {
  filePath: string;
  url: string;
}

/**
 * Signed URL far in the future so certificate/template assets stay reachable
 * without re-signing, mirroring how the legacy gen-certificate service served files.
 */
const SIGNED_URL_FAR_FUTURE = '01-01-2500';

export async function uploadBufferToStorage(
  path: string,
  buffer: Buffer,
  contentType: string,
): Promise<UploadedFileResult> {
  const bucket = admin.storage().bucket();
  const file = bucket.file(path);

  await file.save(buffer, {
    contentType,
    metadata: { cacheControl: 'public, max-age=31536000' },
  });

  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: SIGNED_URL_FAR_FUTURE,
  });

  return { filePath: path, url };
}

export async function downloadBufferFromStorage(path: string): Promise<Buffer> {
  const bucket = admin.storage().bucket();
  const [buffer] = await bucket.file(path).download();
  return buffer;
}

export async function storageFileExists(path: string): Promise<boolean> {
  const bucket = admin.storage().bucket();
  const [exists] = await bucket.file(path).exists();
  return exists;
}
