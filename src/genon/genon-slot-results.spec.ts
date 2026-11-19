import { OUTSIDE_SLOT, localTime, slotOfTime, slotResults } from './genon-slot-results';

const TZ = 'America/Bogota';
// 18-nov-2026 en Bogotá (UTC-5)
const at = (hhmm: string) => new Date(`2026-11-18T${hhmm}:00-05:00`);

describe('slotOfTime', () => {
  const slots = ['18:00', '12:30'];

  it('asigna la última franja que empezó, dentro de la ventana', () => {
    expect(slotOfTime('12:30', slots)).toBe('12:30');
    expect(slotOfTime('13:15', slots)).toBe('12:30');
    expect(slotOfTime('19:40', slots)).toBe('18:00');
  });

  it('fuera de toda franja', () => {
    expect(slotOfTime('09:00', slots)).toBe(OUTSIDE_SLOT);
    expect(slotOfTime('17:10', slots)).toBe(OUTSIDE_SLOT);
  });

  it('hora local en la zona del programa', () => {
    expect(localTime(at('12:30'), TZ)).toBe('12:30');
  });
});

describe('slotResults', () => {
  const msg = (user: string, hhmm: string, status = 'sent', extra: object = {}) => ({
    user_id: user,
    event_id: 'ev',
    organization_id: 'org',
    at: at(hhmm),
    status,
    segment: 'abandon',
    step: '1.1',
    ...extra,
  });
  const enr = (user: string, segment: string, since: string, last: string | null) => ({
    _id: `e-${user}`,
    user_id: user,
    event_id: 'ev',
    segment,
    segment_since: at(since),
    last_activity_at: last ? at(last) : null,
  });
  const prog = (user: string, hhmm: string, to = 100, from = 0, event_id = 'ev') => ({
    user_id: user,
    event_id,
    type: 'activity_progress',
    from,
    to,
    at: at(hhmm),
  });

  const result = slotResults({
    slots: ['12:30', '18:00'],
    timeZone: TZ,
    messages: [
      msg('a', '12:31'), // avanzó y pasó a activo
      msg('b', '13:00', 'sent', { segment: 'inactive', step: '2.1' }), // solo entró
      msg('b', '13:05', 'sent', { segment: 'inactive', step: 'examen' }),
      msg('c', '12:40'), // nada
      msg('d', '12:45', 'holdout'), // control que avanzó solo
      msg('e', '18:02'), // avanzó antes del mensaje: no cuenta
      msg('f', '18:05', 'failed'),
      msg('g', '17:00'), // fuera de franja
    ],
    enrollments: [
      enr('a', 'active', '15:00', '14:00'),
      enr('b', 'active', '15:30', '13:20'),
      enr('c', 'abandon', '08:00', null),
      enr('d', 'abandon', '08:00', '16:00'),
      enr('e', 'abandon', '08:00', '17:00'),
    ],
    progress: [
      prog('a', '14:00'),
      prog('a', '14:10', 50),
      prog('d', '16:00', 30),
      prog('e', '17:00'),
      prog('a', '14:20', 10, 10), // sin cambio: no cuenta
      prog('c', '14:00', 100, 0, 'otro-curso'), // otro curso: no cuenta
    ],
  });
  const slot = (s: string) => result.summary.find((x) => x.slot === s)!;

  it('resume por franja: recibieron frente a control', () => {
    expect(result.summary.map((s) => s.slot)).toEqual(['12:30', '18:00', OUTSIDE_SLOT]);
    expect(slot('12:30').received).toEqual({ people: 3, entered: 2, advanced: 1, became_active: 2 });
    expect(slot('12:30').control).toEqual({ people: 1, entered: 1, advanced: 1, became_active: 0 });
    expect(slot('18:00').received).toEqual({ people: 1, entered: 0, advanced: 0, became_active: 0 });
    expect(slot('18:00').failed).toBe(1);
    expect(slot(OUTSIDE_SLOT).received.people).toBe(1);
  });

  it('lista a quienes entraron, avanzaron o se activaron', () => {
    const a = result.people.find((p) => p.user_id === 'a')!;
    expect(a).toMatchObject({
      slot: '12:30',
      group: 'received',
      advanced: true,
      became_active: true,
      progress_events: 2,
      activities_completed: 1,
      enrollment_id: 'e-a',
    });
    expect(a.first_progress_at).toEqual(at('14:00'));
    const b = result.people.find((p) => p.user_id === 'b')!;
    expect(b).toMatchObject({ entered: true, advanced: false, became_active: true });
    expect(b.steps).toEqual(['2.1', 'examen']);
    expect(result.people.map((p) => p.user_id).sort()).toEqual(['a', 'b', 'd']);
  });
});
