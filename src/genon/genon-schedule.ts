import { createHash } from 'crypto';
import {
  GenOnSegment,
  GenOnSegmentRules,
  GenOnStep,
} from './schemas/genon-program.schema';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Datos de un inscrito para clasificarlo (salen de computeEvent). */
export interface SegmentInput {
  progress: number; // avance del curso 0-100
  completedActivities: number;
  enrolledAt: Date | null;
  lastActivityAt: Date | null;
}

/**
 * Segmento según las reglas del programa:
 * - graduated: terminó el curso.
 * - abandon: sin actividades completadas (o avance <= max) y con los días
 *   mínimos de inscripción; si aún no los cumple, waiting.
 * - inactive: avance > min y más de N días sin actividad.
 * - active: con actividad en los últimos N días.
 */
export function classifySegment(
  input: SegmentInput,
  rules: GenOnSegmentRules,
  now: Date,
): GenOnSegment {
  if (input.progress >= 100) return 'graduated';

  const abandon =
    rules.abandon.rule === 'no_activity'
      ? input.completedActivities === 0
      : input.progress <= rules.abandon.max_progress;
  if (abandon) {
    const enrolledDays = input.enrolledAt
      ? (now.getTime() - input.enrolledAt.getTime()) / DAY_MS
      : Infinity;
    return enrolledDays >= rules.abandon.min_days_enrolled
      ? 'abandon'
      : 'waiting';
  }

  const inactiveDays = input.lastActivityAt
    ? (now.getTime() - input.lastActivityAt.getTime()) / DAY_MS
    : Infinity;
  if (
    input.progress > rules.inactive.min_progress &&
    inactiveDays > rules.inactive.min_days_inactive
  ) {
    return 'inactive';
  }
  return 'active';
}

function bucket(seed: string): number {
  return createHash('sha256').update(seed).digest().readUInt32BE(0);
}

/** Franja estable de la persona (sorteada una vez, igual en cada cálculo). */
export function slotFor(
  programId: string,
  userId: string,
  slots: string[],
): string {
  const valid = slots.filter((s) => /^\d{1,2}:\d{2}$/.test(s));
  if (!valid.length) return '12:00';
  return valid[bucket(`slot:${programId}:${userId}`) % valid.length];
}

/** Grupo de control estable por programa, persona y segmento. */
export function isHoldout(
  programId: string,
  userId: string,
  segment: GenOnSegment,
  percent: number | undefined,
): boolean {
  if (!(Number(percent) > 0)) return false;
  return (
    bucket(`holdout:${programId}:${userId}:${segment}`) % 100 <
    Math.min(Number(percent), 100)
  );
}

/** YYYY-MM-DD en la zona horaria. */
export function localDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
}

/** Diferencia (ms) entre la hora local de la zona y UTC en ese instante. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - date.getTime();
}

/** Instante UTC de una fecha y hora locales en la zona. */
export function zonedTime(ymd: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, min);
  // Dos pasadas por si el desfase cambia justo en ese día
  let result = guess - zoneOffsetMs(new Date(guess), timeZone);
  result = guess - zoneOffsetMs(new Date(result), timeZone);
  return new Date(result);
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function weekday(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Cuándo sale un toque: el día `day` contado desde la entrada al segmento,
 * en la franja de la persona. Si ese día está bloqueado (domingo) pasa al
 * siguiente permitido, y nunca queda en el pasado.
 */
export function stepSendTime(params: {
  segmentSince: Date;
  day: number;
  slot: string;
  timeZone: string;
  blockedWeekdays: number[];
  now: Date;
}): Date {
  const { segmentSince, day, slot, timeZone, now } = params;
  const blocked = new Set(params.blockedWeekdays || []);
  let ymd = addDays(localDate(segmentSince, timeZone), Math.max(0, day));
  for (let i = 0; i < 400; i++) {
    if (!blocked.has(weekday(ymd))) {
      const at = zonedTime(ymd, slot, timeZone);
      if (at.getTime() >= now.getTime()) return at;
    }
    ymd = addDays(ymd, 1);
  }
  return zonedTime(ymd, slot, timeZone);
}

/** Pasos activos de la secuencia, en orden de día. */
export function orderedSteps(steps: GenOnStep[]): GenOnStep[] {
  return (steps || [])
    .filter((s) => s.enabled !== false)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.day - b.s.day || a.i - b.i)
    .map(({ s }) => s);
}

/**
 * Siguiente toque después del último enviado (u omitido). Se decide por día
 * y no por posición, así editar la secuencia no desordena a quien ya va a
 * mitad de camino.
 */
export function nextStep(
  steps: GenOnStep[],
  lastStepKey: string | null,
  lastStepDay: number | null,
): GenOnStep | null {
  const ordered = orderedSteps(steps);
  if (lastStepKey === null || lastStepDay === null) return ordered[0] || null;
  const idx = ordered.findIndex((s) => s.key === lastStepKey);
  if (idx >= 0) return ordered[idx + 1] || null;
  return ordered.find((s) => s.day > lastStepDay) || null;
}
