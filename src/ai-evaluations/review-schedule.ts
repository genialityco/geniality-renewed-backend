/**
 * Horario del repaso automático por WhatsApp (configurado en el Event):
 * días permitidos, franjas de envío y franjas de descanso, evaluadas en la
 * zona horaria del curso. Funciones puras.
 */

const DEFAULT_TIMEZONE = 'America/Bogota';
const DEFAULT_DELAY_DAYS = 2;

export interface TimeWindow {
  start: number; // minutos desde medianoche
  end: number;
}

export interface ReviewSchedule {
  delayDays: number;
  timezone: string;
  days: number[]; // 0 = domingo … 6 = sábado
  windows: TimeWindow[];
  restWindows: TimeWindow[];
}

/** "09:30" → 570; null si no es una hora válida. */
export function parseHHmm(value: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

function parseWindows(list: unknown): TimeWindow[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((w) => ({ start: parseHHmm(w?.start), end: parseHHmm(w?.end) }))
    .filter(
      (w): w is TimeWindow =>
        w.start !== null && w.end !== null && w.start !== w.end,
    );
}

function validTimezone(tz: unknown): string {
  const value = String(tz || '').trim();
  if (!value) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** Configuración del Event saneada (valores inválidos → defaults). */
export function normalizeSchedule(event: Record<string, any>): ReviewSchedule {
  const delay = Math.round(Number(event.whatsapp_review_delay_days));
  const days = Array.isArray(event.whatsapp_review_days)
    ? [...new Set(event.whatsapp_review_days.map(Number))].filter(
        (d) => Number.isInteger(d) && d >= 0 && d <= 6,
      )
    : [1, 2, 3, 4, 5, 6];
  return {
    delayDays: delay >= 1 ? delay : DEFAULT_DELAY_DAYS,
    timezone: validTimezone(event.whatsapp_review_timezone),
    days,
    windows: Array.isArray(event.whatsapp_review_windows)
      ? parseWindows(event.whatsapp_review_windows)
      : [{ start: 9 * 60, end: 19 * 60 }],
    restWindows: Array.isArray(event.whatsapp_review_rest_windows)
      ? parseWindows(event.whatsapp_review_rest_windows)
      : [{ start: 12 * 60, end: 14 * 60 }],
  };
}

/** Día de la semana y minuto del día de `now` en la zona horaria dada. */
export function localTime(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    get('weekday') || '',
  );
  const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  return { weekday, minutes };
}

/** Franja que puede cruzar la medianoche (ej. 22:00–06:00). */
function inWindow(minutes: number, w: TimeWindow): boolean {
  return w.start < w.end
    ? minutes >= w.start && minutes < w.end
    : minutes >= w.start || minutes < w.end;
}

/**
 * ¿Se puede enviar ahora? Día permitido, dentro de alguna franja de envío y
 * fuera de todas las de descanso. Sin franjas de envío no se envía nunca.
 */
export function isWithinSchedule(now: Date, schedule: ReviewSchedule): boolean {
  const { weekday, minutes } = localTime(now, schedule.timezone);
  if (!schedule.days.includes(weekday)) return false;
  if (!schedule.windows.some((w) => inWindow(minutes, w))) return false;
  return !schedule.restWindows.some((w) => inWindow(minutes, w));
}
