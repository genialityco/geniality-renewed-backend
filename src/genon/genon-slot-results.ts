/**
 * Resultados por franja de envío: de los mensajes de Gen.ON de un día, quién
 * los recibió en cada franja (y quién estaba en el grupo de control a esa
 * misma hora) y qué hizo después: entró al curso, avanzó o pasó a activo.
 */

/** Envíos que salen en una franja pueden tardar (tope por corrida del cron). */
export const SLOT_WINDOW_MINUTES = 180;
/** Mensajes fuera de toda franja (p. ej. un disparador inmediato) */
export const OUTSIDE_SLOT = 'otro';

const RECEIVED = new Set(['sent', 'fallback_email']);
const NOT_DELIVERED = new Set(['failed', 'pending']);

export interface SlotMessage {
  user_id: string;
  event_id: string | null;
  organization_id: string;
  at: Date;
  status: string;
  segment: string | null;
  step: string | null;
  read_at?: Date | null;
  clicked_at?: Date | null;
}

export interface SlotEnrollment {
  _id: unknown;
  user_id: string;
  event_id: string;
  segment: string;
  segment_since: Date;
  last_activity_at: Date | null;
}

export interface SlotProgress {
  user_id: string;
  event_id: string;
  type: string;
  from: number;
  to: number;
  at: Date;
}

export interface SlotGroupStats {
  /** Personas distintas */
  people: number;
  /** Entraron al curso después del mensaje (según la última segmentación) */
  entered: number;
  /** Tuvieron avance registrado después del mensaje */
  advanced: number;
  /** Pasaron a activo después del mensaje (venían de otro segmento) */
  became_active: number;
}

export interface SlotSummary {
  slot: string;
  received: SlotGroupStats;
  control: SlotGroupStats;
  /** Personas a las que el mensaje no les llegó (falló el envío) */
  failed: number;
}

export type SlotGroup = 'received' | 'control';

export interface SlotPerson {
  slot: string;
  group: SlotGroup;
  user_id: string;
  organization_id: string;
  event_id: string | null;
  enrollment_id: string | null;
  /** Segmento al enviarle el mensaje */
  segment_at_send: string | null;
  segment_now: string | null;
  steps: string[];
  sent_at: Date;
  first_progress_at: Date | null;
  /** Registros de avance después del mensaje */
  progress_events: number;
  /** Actividades que terminó después del mensaje */
  activities_completed: number;
  entered: boolean;
  advanced: boolean;
  became_active: boolean;
  read: boolean;
  clicked: boolean;
}

/** Segmentos a los que se llega al recuperarse de abandono o inactividad */
export const RECOVERED_SEGMENTS = new Set(['active', 'graduated']);

export interface RecoveryStats {
  /** Recibieron al menos un toque de la secuencia del segmento */
  received: { people: number; recovered: number };
  /** Grupo de control del segmento (no recibieron los toques) */
  control: { people: number; recovered: number };
}

/**
 * Recuperados por segmento: de quienes entraron a la secuencia de abandono o
 * de inactivos (con mensaje o en el grupo de control), cuántos están hoy en
 * activos o egresados y llegaron ahí después de su primer toque.
 */
export function segmentRecovery(
  recipients: {
    user_id: string;
    event_id: string | null;
    segment: string;
    first_at: Date;
    received: boolean;
  }[],
  enrollments: { user_id: string; event_id: string; segment: string; segment_since: Date }[],
): Record<string, RecoveryStats> {
  const current = new Map(enrollments.map((e) => [`${e.user_id}:${e.event_id}`, e]));
  const out: Record<string, RecoveryStats> = {};
  for (const r of recipients) {
    const stats = (out[r.segment] ||= {
      received: { people: 0, recovered: 0 },
      control: { people: 0, recovered: 0 },
    });
    const group = r.received ? stats.received : stats.control;
    group.people++;
    const e = current.get(`${r.user_id}:${r.event_id}`);
    if (
      e &&
      RECOVERED_SEGMENTS.has(e.segment) &&
      new Date(e.segment_since).getTime() >= new Date(r.first_at).getTime()
    ) {
      group.recovered++;
    }
  }
  return out;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Hora local HH:mm de un instante. */
export function localTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * Franja a la que pertenece un envío: la última que empezó antes de él, si
 * no hace más de `windowMinutes`; si no, OUTSIDE_SLOT.
 */
export function slotOfTime(
  hhmm: string,
  slots: string[],
  windowMinutes = SLOT_WINDOW_MINUTES,
): string {
  const t = toMinutes(hhmm);
  const started = slots
    .filter((s) => toMinutes(s) <= t)
    .sort((a, b) => toMinutes(b) - toMinutes(a));
  const slot = started[0];
  return slot && t - toMinutes(slot) < windowMinutes ? slot : OUTSIDE_SLOT;
}

const emptyStats = (): SlotGroupStats => ({
  people: 0,
  entered: 0,
  advanced: 0,
  became_active: 0,
});

/**
 * Agrupa los mensajes del día por franja y por persona (cuenta el primer
 * mensaje de cada persona en la franja) y mide lo que pasó después de él.
 * Devuelve el resumen por franja y las personas que entraron, avanzaron o
 * pasaron a activo.
 */
export function slotResults(params: {
  messages: SlotMessage[];
  enrollments: SlotEnrollment[];
  progress: SlotProgress[];
  slots: string[];
  timeZone: string;
}): { summary: SlotSummary[]; people: SlotPerson[] } {
  const { messages, enrollments, progress, slots, timeZone } = params;

  const enrollmentOf = new Map<string, SlotEnrollment>();
  for (const e of enrollments) {
    enrollmentOf.set(`${e.user_id}:${e.event_id}`, e);
    // Respaldo para mensajes sin curso: la primera inscripción de la persona
    if (!enrollmentOf.has(e.user_id)) enrollmentOf.set(e.user_id, e);
  }
  const progressOf = new Map<string, SlotProgress[]>();
  for (const p of progress) {
    const list = progressOf.get(p.user_id) || [];
    list.push(p);
    progressOf.set(p.user_id, list);
  }

  // Primer mensaje de cada persona por franja y grupo
  type Entry = { first: SlotMessage; steps: Set<string>; read: boolean; clicked: boolean };
  const entries = new Map<string, Entry>();
  const failed = new Map<string, Set<string>>();
  const ordered = [...messages].sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const m of ordered) {
    const slot = slotOfTime(localTime(m.at, timeZone), slots);
    if (NOT_DELIVERED.has(m.status)) {
      const set = failed.get(slot) || new Set<string>();
      set.add(m.user_id);
      failed.set(slot, set);
      continue;
    }
    const group: SlotGroup | null = RECEIVED.has(m.status)
      ? 'received'
      : m.status === 'holdout'
        ? 'control'
        : null;
    if (!group) continue;
    const key = `${slot}|${group}|${m.user_id}`;
    const entry = entries.get(key) || {
      first: m,
      steps: new Set<string>(),
      read: false,
      clicked: false,
    };
    if (m.step) entry.steps.add(m.step);
    entry.read ||= Boolean(m.read_at);
    entry.clicked ||= Boolean(m.clicked_at);
    entries.set(key, entry);
  }

  const summaryBySlot = new Map<string, SlotSummary>();
  const summaryFor = (slot: string) => {
    let s = summaryBySlot.get(slot);
    if (!s) {
      s = { slot, received: emptyStats(), control: emptyStats(), failed: 0 };
      summaryBySlot.set(slot, s);
    }
    return s;
  };

  const people: SlotPerson[] = [];
  for (const [key, { first: m, steps, read, clicked }] of entries) {
    const [slot, group] = key.split('|') as [string, SlotGroup];
    // Quien recibió el mensaje en la franja no cuenta también como control
    if (group === 'control' && entries.has(`${slot}|received|${m.user_id}`)) continue;

    const enrollment =
      enrollmentOf.get(`${m.user_id}:${m.event_id}`) ||
      (m.event_id ? undefined : enrollmentOf.get(m.user_id));
    const eventId = m.event_id || enrollment?.event_id || null;
    const after = (progressOf.get(m.user_id) || [])
      .filter((p) => p.at >= m.at && (!eventId || p.event_id === eventId) && p.to > p.from)
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const advanced = after.length > 0;
    const entered = Boolean(
      advanced || (enrollment?.last_activity_at && enrollment.last_activity_at >= m.at),
    );
    const becameActive = Boolean(
      enrollment &&
        m.segment !== 'active' &&
        enrollment.segment === 'active' &&
        new Date(enrollment.segment_since) >= m.at,
    );

    const stats = summaryFor(slot)[group];
    stats.people++;
    if (entered) stats.entered++;
    if (advanced) stats.advanced++;
    if (becameActive) stats.became_active++;

    if (entered || becameActive) {
      people.push({
        slot,
        group,
        user_id: m.user_id,
        organization_id: m.organization_id,
        event_id: eventId,
        enrollment_id: enrollment ? String(enrollment._id) : null,
        segment_at_send: m.segment,
        segment_now: enrollment?.segment || null,
        steps: [...steps],
        sent_at: m.at,
        first_progress_at: after[0]?.at || null,
        progress_events: after.length,
        activities_completed: after.filter(
          (p) => p.type === 'activity_progress' && p.to >= 100,
        ).length,
        entered,
        advanced,
        became_active: becameActive,
        read,
        clicked,
      });
    }
  }
  for (const [slot, users] of failed) summaryFor(slot).failed = users.size;

  const order = (slot: string) => (slot === OUTSIDE_SLOT ? Infinity : toMinutes(slot));
  const summary = [...summaryBySlot.values()].sort((a, b) => order(a.slot) - order(b.slot));
  people.sort(
    (a, b) =>
      order(a.slot) - order(b.slot) ||
      a.group.localeCompare(b.group) ||
      Number(b.advanced) - Number(a.advanced) ||
      a.sent_at.getTime() - b.sent_at.getTime(),
  );
  return { summary, people };
}
