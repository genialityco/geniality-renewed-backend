/**
 * Racha académica (regla del documento de Gen.ON):
 * - Cuenta días calendario consecutivos (hora de Colombia) con al menos una
 *   actividad académica válida: completar una actividad o superar un reto.
 *   Abrir la app, leer un mensaje o hacer clic no cuenta.
 * - Un día completo sin actividad válida interrumpe la racha.
 * - Un reto superado recupera la racha interrumpida: los días sin estudio
 *   quedan "puenteados" (no se inventa actividad en ellos ni se cuentan).
 *
 * Los días son strings YYYY-MM-DD en la zona del programa.
 */

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Días con actividad que terminan en `day`, hacia atrás (los puenteados enlazan sin contar). */
function chainEndingAt(
  day: string,
  valid: Set<string>,
  bridged: Set<string>,
): { count: number; start: string | null } {
  let count = 0;
  let start: string | null = null;
  let cursor = day;
  // Tope de seguridad: más de un año de racha no cambia ningún mensaje
  for (let i = 0; i < 400; i++) {
    if (valid.has(cursor)) {
      count++;
      start = cursor;
    } else if (!bridged.has(cursor)) {
      break;
    }
    cursor = addDays(cursor, -1);
  }
  return { count, start };
}

export interface StreakState {
  /** Racha viva: incluye hoy si ya hubo actividad hoy */
  current: number;
  /** Día en que empezó la racha viva */
  start: string | null;
  /** Racha que termina ayer (para hitos y aviso de riesgo) */
  throughYesterday: number;
  /** Día en que empezó la racha que termina ayer */
  startThroughYesterday: string | null;
  activeToday: boolean;
  /** Se cortó ayer: ayer sin actividad y antes de ayer con racha */
  broken: { count: number; lastDay: string } | null;
  lastValidDay: string | null;
}

export function streakState(
  validDays: Iterable<string>,
  bridgedDays: Iterable<string>,
  today: string,
): StreakState {
  const valid = new Set(validDays);
  const bridged = new Set(bridgedDays);
  const yesterday = addDays(today, -1);
  const dayBefore = addDays(today, -2);
  const linked = (d: string) => valid.has(d) || bridged.has(d);

  const activeToday = valid.has(today);
  const untilYesterday = linked(yesterday)
    ? chainEndingAt(yesterday, valid, bridged)
    : { count: 0, start: null };
  const live = activeToday ? chainEndingAt(today, valid, bridged) : untilYesterday;

  let broken: StreakState['broken'] = null;
  if (!activeToday && !linked(yesterday) && linked(dayBefore)) {
    const prev = chainEndingAt(dayBefore, valid, bridged);
    if (prev.count > 0) broken = { count: prev.count, lastDay: dayBefore };
  }

  const lastValidDay =
    [...valid].filter((d) => d <= today).sort().pop() || null;

  return {
    current: live.count,
    start: live.start,
    throughYesterday: untilYesterday.count,
    startThroughYesterday: untilYesterday.start,
    activeToday,
    broken,
    lastValidDay,
  };
}

/**
 * Días a puentear cuando un reto superado hoy recupera una racha cortada:
 * los días sin actividad entre el último día válido y hoy, si no son más que
 * `windowDays`. Vacío si no hay racha que recuperar.
 */
export function daysToBridge(
  validDays: Iterable<string>,
  bridgedDays: Iterable<string>,
  today: string,
  windowDays: number,
): string[] {
  const valid = new Set(validDays);
  const bridged = new Set(bridgedDays);
  let cursor = addDays(today, -1);
  const gap: string[] = [];
  while (gap.length <= windowDays) {
    if (valid.has(cursor)) return gap;
    if (!bridged.has(cursor)) gap.push(cursor);
    cursor = addDays(cursor, -1);
  }
  return [];
}

// ───────────────────────── Protector de racha ─────────────────────────

export interface ShieldRules {
  enabled: boolean;
  /** Actividades en un mismo día para ganar un protector */
  minActivities: number;
  /** Protectores que se pueden tener guardados */
  max: number;
}

export interface ShieldState {
  /** Días sin estudio que cubrió un protector (enlazan la racha sin contar) */
  shielded: string[];
  /** Protectores guardados hoy */
  shields: number;
  /** Hoy ganó uno (hizo las actividades necesarias y tenía cupo) */
  earnedToday: boolean;
}

/**
 * Protector de racha: un día con `minActivities` actividades o más gana uno
 * (hasta `max` guardados) y el primer día sin estudio que viene después se
 * cubre solo, sin cortar la racha. Se recalcula siempre desde los días de
 * estudio, en orden: lo ganado un día solo cubre días posteriores. Los días
 * ya puenteados por un reto no gastan protector. Hoy aún no se cubre (el día
 * no ha terminado), pero lo ganado hoy ya cuenta.
 */
export function applyShields(
  activitiesByDay: Map<string, number>,
  validDays: Iterable<string>,
  bridgedDays: Iterable<string>,
  today: string,
  rules: ShieldRules,
): ShieldState {
  const none = { shielded: [], shields: 0, earnedToday: false };
  if (!rules.enabled || rules.max < 1) return none;
  const valid = new Set(validDays);
  const bridged = new Set(bridgedDays);
  const first = [...valid].filter((d) => d <= today).sort()[0];
  if (!first) return none;
  const earns = (d: string) => (activitiesByDay.get(d) || 0) >= Math.max(1, rules.minActivities);

  let shields = 0;
  const shielded: string[] = [];
  for (let d = first; d < today; d = addDays(d, 1)) {
    if (valid.has(d)) {
      if (earns(d)) shields = Math.min(rules.max, shields + 1);
    } else if (!bridged.has(d) && shields > 0) {
      shields--;
      shielded.push(d);
    }
  }
  const earnedToday = earns(today) && shields < rules.max;
  if (earnedToday) shields++;
  return { shielded, shields, earnedToday };
}

// ───────────────────────── Medallas ─────────────────────────

export type StreakMedalTier = 'bronze' | 'silver' | 'gold' | 'diamond';

/** Una medalla por hito, en orden; los hitos de más reciben la última. */
const MEDALS: { tier: StreakMedalTier; name: string }[] = [
  { tier: 'bronze', name: 'bronce' },
  { tier: 'silver', name: 'plata' },
  { tier: 'gold', name: 'oro' },
  { tier: 'diamond', name: 'diamante' },
];

export interface StreakMedal {
  tier: StreakMedalTier;
  /** Nombre para los textos: "bronce", "plata"… */
  name: string;
  /** Días del hito que la otorga */
  days: number;
}

function medalAt(sorted: number[], i: number): StreakMedal {
  const m = MEDALS[Math.min(i, MEDALS.length - 1)];
  return { ...m, days: sorted[i] };
}

const sortedMilestones = (milestones: number[]) =>
  [...new Set(milestones.filter((m) => m > 0))].sort((a, b) => a - b);

/** Medalla de una racha de `days` días: la del hito más alto alcanzado. */
export function medalFor(days: number, milestones: number[]): StreakMedal | null {
  const sorted = sortedMilestones(milestones);
  const i = sorted.filter((m) => m <= days).length - 1;
  return i < 0 ? null : medalAt(sorted, i);
}

/** Próxima medalla y cuántos días le faltan. */
export function nextMedal(
  days: number,
  milestones: number[],
): (StreakMedal & { missing: number }) | null {
  const sorted = sortedMilestones(milestones);
  const i = sorted.findIndex((m) => m > days);
  return i < 0 ? null : { ...medalAt(sorted, i), missing: sorted[i] - days };
}
