import { classifySegment, localDate } from './genon-schedule';
import { streakState } from './genon-streak';
import { defaultSegments, defaultTriggers } from './genon-defaults';
import { DEMO_STAGES, DemoCourseShape, findDemoStep, scenarioFor } from './genon-demo-script';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-21T15:00:00Z');
const TZ = 'America/Bogota';

/** Lo que vería Gen.ON de un participante con el escenario de la etapa. */
function evaluate(stageKey: (typeof DEMO_STAGES)[number]['key'], shape: DemoCourseShape) {
  const s = scenarioFor(stageKey, shape);
  const ago = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
  const last = s.completed.length ? Math.min(...s.completed.map((c) => c.daysAgo)) : null;
  const segment = classifySegment(
    {
      progress: Math.round((s.completed.length / shape.activityCount) * 100),
      completedActivities: s.completed.length,
      enrolledAt: ago(s.enrolledDaysAgo),
      lastActivityAt: last === null ? null : ago(last),
    },
    defaultSegments(),
    NOW,
  );
  const streak = streakState(
    s.completed.map((c) => localDate(ago(c.daysAgo), TZ)),
    [],
    localDate(NOW, TZ),
  );
  return { s, segment, streak };
}

describe.each([
  { activityCount: 8, firstModuleSize: 2 }, // curso de prueba: 4 módulos de 2
  { activityCount: 12, firstModuleSize: 4 },
])('escenarios de la demostración (curso %o)', (shape) => {
  it.each(DEMO_STAGES.map((st) => [st.key, st.segment] as const))(
    'la etapa %s deja a la persona en el segmento %s',
    (stage, segment) => {
      expect(evaluate(stage, shape).segment).toBe(segment);
    },
  );

  it('activos: termina el primer módulo y su racha que acaba ayer es un hito y está en riesgo', () => {
    const { s, streak } = evaluate('active', shape);
    const done = new Set(s.completed.map((c) => c.index));
    for (let i = 0; i < shape.firstModuleSize; i++) expect(done.has(i)).toBe(true);
    const cfg = defaultTriggers().streak;
    expect(streak.activeToday).toBe(false);
    expect(streak.throughYesterday).toBeGreaterThanOrEqual(cfg.risk_min);
    if (shape.firstModuleSize <= 3) expect(cfg.milestones).toContain(streak.throughYesterday);
  });

  it('racha cortada: ayer sin estudio y una racha de 3 días que se puede recuperar', () => {
    const { streak } = evaluate('recovery', shape);
    expect(streak.broken?.count).toBeGreaterThanOrEqual(defaultTriggers().streak.recovery_min);
  });

  it('examen: el primer módulo completo hace más de los días del recordatorio, sin egresar', () => {
    const { s } = evaluate('exam', shape);
    expect(s.completed.map((c) => c.index)).toEqual(
      Array.from({ length: shape.firstModuleSize }, (_, i) => i),
    );
    const last = Math.min(...s.completed.map((c) => c.daysAgo));
    expect(last).toBeGreaterThanOrEqual(defaultTriggers().exam_reminder.days_after);
  });

  it('egresado: todas las actividades y los exámenes aprobados', () => {
    const { s } = evaluate('graduated', shape);
    expect(s.completed).toHaveLength(shape.activityCount);
    expect(s.passExams).toBe(true);
  });
});

describe('guion', () => {
  it('los pasos tienen ids únicos que se encuentran con su etapa', () => {
    const ids = DEMO_STAGES.flatMap((st) => st.steps.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const st of DEMO_STAGES) {
      for (const s of st.steps) expect(findDemoStep(s.id)?.stage.key).toBe(st.key);
    }
  });
});
