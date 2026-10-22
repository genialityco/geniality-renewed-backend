import { addDays, daysToBridge, streakState } from './genon-streak';

const TODAY = '2026-10-21';
const d = (n: number) => addDays(TODAY, -n); // d(1) = ayer

describe('streakState', () => {
  it('cuenta los días consecutivos hasta hoy si hoy hubo actividad', () => {
    const s = streakState([d(0), d(1), d(2)], [], TODAY);
    expect(s).toMatchObject({ current: 3, throughYesterday: 2, activeToday: true, broken: null });
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
