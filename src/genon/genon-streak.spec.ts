import { addDays, applyShields, daysToBridge, medalFor, nextMedal, streakRuns, streakState } from './genon-streak';

const TODAY = '2026-10-21';
const d = (n: number) => addDays(TODAY, -n); // d(1) = ayer

describe('streakState', () => {
  it('cuenta los días consecutivos hasta hoy si hoy hubo actividad', () => {
    const s = streakState([d(0), d(1), d(2)], [], TODAY);
    expect(s).toMatchObject({ current: 3, throughYesterday: 2, activeToday: true, broken: null });
    expect(s.start).toBe(d(2));
  });

  it('si hoy aún no estudia, la racha viva es la que termina ayer', () => {
    const s = streakState([d(1), d(2), d(3)], [], TODAY);
    expect(s).toMatchObject({
      current: 3,
      throughYesterday: 3,
      startThroughYesterday: d(3),
      activeToday: false,
      broken: null,
    });
  });

  it('varias actividades el mismo día cuentan un solo día', () => {
    const s = streakState([d(1), d(1), d(2)], [], TODAY);
    expect(s.throughYesterday).toBe(2);
  });

  it('un día completo sin actividad la corta (y se ofrece recuperarla hoy)', () => {
    const s = streakState([d(2), d(3), d(4)], [], TODAY);
    expect(s).toMatchObject({
      current: 0,
      throughYesterday: 0,
      broken: { count: 3, lastDay: d(2) },
    });
  });

  it('los días puenteados enlazan la racha sin contarse', () => {
    // Estudió hace 3 y 4 días, no estudió hace 2, se recuperó ayer
    const s = streakState([d(1), d(3), d(4)], [d(2)], TODAY);
    expect(s.throughYesterday).toBe(3);
  });

  it('sin actividad no hay racha', () => {
    expect(streakState([], [], TODAY)).toMatchObject({
      current: 0,
      throughYesterday: 0,
      broken: null,
      lastValidDay: null,
    });
  });
});

describe('daysToBridge', () => {
  it('puentea los días sin estudio dentro de la ventana', () => {
    expect(daysToBridge([d(3)], [], TODAY, 2)).toEqual([d(1), d(2)]);
  });

  it('no puentea si la racha se cortó hace más días que la ventana', () => {
    expect(daysToBridge([d(5)], [], TODAY, 2)).toEqual([]);
  });

  it('no hay nada que puentear si ayer estudió', () => {
    expect(daysToBridge([d(1)], [], TODAY, 2)).toEqual([]);
  });

  it('nunca puentea sin actividad previa', () => {
    expect(daysToBridge([], [], TODAY, 2)).toEqual([]);
  });
});

describe('medallas de racha', () => {
  const MILESTONES = [3, 7, 14, 30];

  it('sin llegar al primer hito no hay medalla', () => {
    expect(medalFor(2, MILESTONES)).toBeNull();
  });

  it('la medalla es la del hito más alto alcanzado', () => {
    expect(medalFor(3, MILESTONES)).toEqual({ tier: 'bronze', name: 'bronce', days: 3 });
    expect(medalFor(10, MILESTONES)).toEqual({ tier: 'silver', name: 'plata', days: 7 });
    expect(medalFor(45, MILESTONES)).toEqual({ tier: 'diamond', name: 'diamante', days: 30 });
  });

  it('acepta hitos desordenados y repite la última medalla si hay más hitos', () => {
    expect(medalFor(60, [60, 3, 7, 14, 30])).toMatchObject({ tier: 'diamond', days: 60 });
  });

  it('próxima medalla y días que faltan', () => {
    expect(nextMedal(5, MILESTONES)).toEqual({ tier: 'silver', name: 'plata', days: 7, missing: 2 });
    expect(nextMedal(30, MILESTONES)).toBeNull();
  });
});

describe('protector de racha', () => {
  const T = '2026-10-21';
  const rules = { enabled: true, minActivities: 2, max: 1 };
  const acts = (entries: [number, number][]) =>
    new Map(entries.map(([n, count]) => [addDays(T, -n), count]));

  it('no se acumulan más de los permitidos ni se gana hoy si ya está lleno', () => {
    const a = acts([[3, 2], [2, 3], [1, 1], [0, 2]]);
    const s = applyShields(a, a.keys(), [], T, rules);
    expect(s).toEqual({ shielded: [], shields: 1, earnedToday: false });
  });

  it('cubre solo un día: el segundo seguido sin estudio corta la racha', () => {
    const a = acts([[4, 2]]);
    const s = applyShields(a, a.keys(), [], T, rules);
    expect(s.shielded).toEqual([addDays(T, -3)]);
    expect(streakState(a.keys(), s.shielded, T).current).toBe(0);
  });

  it('un día ya recuperado con un reto no gasta el protector', () => {
    const a = acts([[3, 2], [1, 1]]);
    const s = applyShields(a, a.keys(), [addDays(T, -2)], T, rules);
    expect(s).toMatchObject({ shielded: [], shields: 1 });
  });

  it('apagado no cubre nada', () => {
    const a = acts([[2, 3]]);
    expect(applyShields(a, a.keys(), [], T, { ...rules, enabled: false }).shields).toBe(0);
  });
});

describe('streakRuns', () => {
  const M = [3, 7];

  it('separa las rachas cortadas y marca viva la de hoy, la más reciente primero', () => {
    const runs = streakRuns([d(10), d(9), d(8), d(5), d(1), d(0)], new Map(), TODAY, M);
    expect(runs.map((r) => [r.start, r.end, r.days, r.status, r.lost_on])).toEqual([
      [d(1), d(0), 2, 'live', null],
      [d(5), d(5), 1, 'lost', d(4)],
      [d(10), d(8), 3, 'lost', d(7)],
    ]);
    expect(runs[2].medal?.name).toBe('bronce');
    expect(runs[0].medal).toBeNull();
  });

  it('sigue viva si estudió ayer aunque hoy aún no', () => {
    expect(streakRuns([d(2), d(1)], new Map(), TODAY, M)[0]).toMatchObject({ status: 'live', days: 2 });
  });

  it('los días cubiertos enlazan sin contar y se listan', () => {
    const covered = new Map<string, 'challenge' | 'shield'>([
      [d(4), 'shield'],
      [d(1), 'challenge'],
    ]);
    const [run] = streakRuns([d(5), d(3), d(2)], covered, TODAY, M);
    expect(run).toMatchObject({ start: d(5), end: d(2), days: 3, status: 'live' });
    // El cubierto de ayer la mantiene viva, pero no está entre inicio y fin
    expect(run.covered).toEqual([{ day: d(4), by: 'shield' }]);
  });

  it('sin días de estudio no hay rachas', () => {
    expect(streakRuns([], new Map(), TODAY, M)).toEqual([]);
  });
});
