import {
  classifySegment,
  isHoldout,
  localDate,
  nextStep,
  slotFor,
  stepSendTime,
  zonedTime,
} from './genon-schedule';
import { defaultFlows, defaultSegments } from './genon-defaults';

const TZ = 'America/Bogota';
const DAY = 24 * 3600 * 1000;
const NOW = new Date('2026-10-21T15:00:00Z'); // miércoles 10:00 en Bogotá
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

describe('classifySegment', () => {
  const rules = defaultSegments();

  it('egresado al 100 %', () => {
    expect(
      classifySegment(
        { progress: 100, completedActivities: 10, enrolledAt: daysAgo(90), lastActivityAt: daysAgo(1) },
        rules,
        NOW,
      ),
    ).toBe('graduated');
  });

  it('abandono: ninguna actividad completada y 7+ días inscrito', () => {
    expect(
      classifySegment(
        { progress: 0, completedActivities: 0, enrolledAt: daysAgo(10), lastActivityAt: null },
        rules,
        NOW,
      ),
    ).toBe('abandon');
  });

  it('en espera si aún no lleva los días mínimos inscrito', () => {
    expect(
      classifySegment(
        { progress: 0, completedActivities: 0, enrolledAt: daysAgo(3), lastActivityAt: null },
        rules,
        NOW,
      ),
    ).toBe('waiting');
  });

  it('con la regla de avance máximo usa el porcentaje', () => {
    const byProgress = { ...rules, abandon: { ...rules.abandon, rule: 'max_progress' as const } };
    expect(
      classifySegment(
        { progress: 4, completedActivities: 1, enrolledAt: daysAgo(10), lastActivityAt: daysAgo(1) },
        byProgress,
        NOW,
      ),
    ).toBe('abandon');
  });

  it('inactivo: más de 5 % y más de 15 días sin actividad', () => {
    expect(
      classifySegment(
        { progress: 30, completedActivities: 3, enrolledAt: daysAgo(60), lastActivityAt: daysAgo(20) },
        rules,
        NOW,
      ),
    ).toBe('inactive');
  });

  it('activo: actividad en los últimos 15 días', () => {
    expect(
      classifySegment(
        { progress: 30, completedActivities: 3, enrolledAt: daysAgo(60), lastActivityAt: daysAgo(2) },
        rules,
        NOW,
      ),
    ).toBe('active');
  });
});

describe('stepSendTime', () => {
  const base = {
    slot: '12:30',
    timeZone: TZ,
    blockedWeekdays: [0],
  };

  it('sale el día del toque en la franja, en hora de Colombia', () => {
    const at = stepSendTime({ ...base, segmentSince: NOW, day: 0, now: NOW });
    // 12:30 en Bogotá = 17:30 UTC
    expect(at.toISOString()).toBe('2026-10-21T17:30:00.000Z');
  });

  it('si la franja de hoy ya pasó, sale al día siguiente', () => {
    const late = new Date('2026-10-21T23:00:00Z'); // 18:00 en Bogotá
    const at = stepSendTime({ ...base, segmentSince: late, day: 0, now: late });
    expect(localDate(at, TZ)).toBe('2026-10-22');
  });

  it('el domingo pasa al lunes', () => {
    // Día 4 desde el miércoles 21 = domingo 25
    const at = stepSendTime({ ...base, segmentSince: NOW, day: 4, now: NOW });
    expect(localDate(at, TZ)).toBe('2026-10-26');
  });

  it('respeta los días del toque', () => {
    const at = stepSendTime({ ...base, segmentSince: NOW, day: 7, now: NOW });
    expect(localDate(at, TZ)).toBe('2026-10-28');
  });
});

describe('zonedTime', () => {
  it('convierte hora local a UTC', () => {
    expect(zonedTime('2026-10-21', '19:00', TZ).toISOString()).toBe(
      '2026-10-22T00:00:00.000Z',
    );
  });
});

describe('nextStep', () => {
  const steps = defaultFlows().abandon;

  it('empieza por el primer toque', () => {
    expect(nextStep(steps, null, null)?.key).toBe('1.1');
  });

  it('sigue con el toque siguiente', () => {
    expect(nextStep(steps, '1.2', 3)?.key).toBe('1.3');
  });

  it('salta los toques desactivados', () => {
    const edited = steps.map((s) => (s.key === '1.2' ? { ...s, enabled: false } : s));
    expect(nextStep(edited, '1.1', 0)?.key).toBe('1.3');
  });

  it('si el último toque ya no existe, sigue por día', () => {
    const edited = steps.filter((s) => s.key !== '1.2');
    expect(nextStep(edited, '1.2', 3)?.key).toBe('1.3');
  });

  it('termina después del cierre', () => {
    expect(nextStep(steps, '1.4', 14)).toBeNull();
  });
});

describe('franja y grupo de control', () => {
  it('la franja es estable para la misma persona', () => {
    const slots = ['12:30', '19:00'];
    expect(slotFor('p1', 'u1', slots)).toBe(slotFor('p1', 'u1', slots));
    expect(slots).toContain(slotFor('p1', 'u1', slots));
  });

  it('reparte el grupo de control según el porcentaje', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `u${i}`);
    const holdout = ids.filter((id) => isHoldout('p1', id, 'abandon', 20)).length;
    expect(holdout).toBeGreaterThan(330);
    expect(holdout).toBeLessThan(470);
    expect(isHoldout('p1', 'u1', 'abandon', 0)).toBe(false);
  });
});
