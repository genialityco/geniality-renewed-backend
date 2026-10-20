import { createHash } from 'crypto';

export const ENGAGEMENT_TIMEZONE = 'America/Bogota';

/**
 * Lunes (YYYY-MM-DD) de la semana local de `date`. Sirve de clave para los
 * mensajes que salen como máximo una vez por semana.
 */
export function localWeekKey(
  date: Date,
  timeZone: string = ENGAGEMENT_TIMEZONE,
): string {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
  const day = new Date(`${ymd}T00:00:00Z`);
  const daysSinceMonday = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - daysSinceMonday);
  return day.toISOString().slice(0, 10);
}

/**
 * Grupo de control estable: el mismo usuario cae siempre en el mismo bucket
 * (0-99), así que subir el porcentaje solo agrega usuarios al grupo.
 */
export function holdoutBucket(userId: string): number {
  const digest = createHash('sha256').update(`holdout:${userId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

export function isInHoldout(userId: string, percent: number): boolean {
  if (!(percent > 0)) return false;
  return holdoutBucket(String(userId)) < Math.min(percent, 100);
}
