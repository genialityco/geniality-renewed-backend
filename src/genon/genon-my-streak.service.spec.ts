import { GenOnMyStreakService } from './genon-my-streak.service';
import { defaultProgram } from './genon-defaults';
import { addDays } from './genon-streak';

const NOW = new Date('2026-10-21T15:00:00Z'); // 10:00 en Bogotá
const TODAY = '2026-10-21';
const d = (n: number) => addDays(TODAY, -n);

function view(
  studied: Record<number, { activities?: number; challenges?: number }>,
  extra: Record<string, any> = {},
) {
  const days = new Map(
    Object.entries(studied).map(([n, v]) => [
      d(Number(n)),
      { activities: v.activities || 0, challenges: v.challenges || 0 },
    ]),
  );
  const triggers = { studyDays: jest.fn().mockResolvedValue(days) };
  const svc = new GenOnMyStreakService(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    triggers as any,
  );
  const program: any = { _id: 'p1', ...defaultProgram(), mode: 'live', timezone: 'America/Bogota' };
  const e: any = {
    _id: 'e1',
    user_id: 'u1',
    event_id: 'ev1',
    organization_id: 'org1',
    exited: false,
    holdout: false,
    streak: { current: 0, best: 5 },
    streak_bridged: [],
    streak_seen: [],
    ...extra,
  };
  return svc.view(program, e, 'Endocrinología', NOW);
}

describe('GenOnMyStreakService: la racha del estudiante', () => {
  it('hoy llegó al hito: medalla, qué hizo cada día y aviso pendiente', async () => {
    const s = await view({ 0: { activities: 2 }, 1: { challenges: 1 }, 2: { activities: 1 } });

    expect(s).toMatchObject({
      current: 3,
      status: 'safe',
      active_today: true,
      medal: { tier: 'bronze', days: 3 },
      next_medal: { tier: 'silver', missing: 4 },
      celebrate: { kind: 'milestone', days: 3, key: `milestone:${d(2)}:3` },
      whatsapp: true,
    });
    expect(s.days).toEqual([
      { day: d(0), activities: 2, challenges: 0, recovered: false },
      { day: d(1), activities: 0, challenges: 1, recovered: false },
      { day: d(2), activities: 1, challenges: 0, recovered: false },
    ]);
    // Para seguir: estudiar mañana antes de que termine el día
    expect(s.deadline).toBe('2026-10-23T04:59:00.000Z');
  });

  it('el aviso ya visto no se repite', async () => {
    const s = await view(
      { 0: { activities: 1 }, 1: { activities: 1 }, 2: { activities: 1 } },
      { streak_seen: [`milestone:${d(2)}:3`] },
    );
    expect(s.celebrate).toBeNull();
  });

  it('un día sin hito avisa que hoy ya cuenta', async () => {
    const s = await view({ 0: { activities: 1 }, 1: { activities: 1 } });
    expect(s.celebrate).toMatchObject({ kind: 'day', days: 2, key: `day:${TODAY}` });
    expect(s.medal).toBeNull();
  });

  it('si hoy aún no estudia, la racha está en riesgo hasta el fin del día', async () => {
    const s = await view({ 1: { activities: 1 }, 2: { activities: 1 } });
    expect(s).toMatchObject({ current: 2, status: 'at_risk', celebrate: null });
    expect(s.deadline).toBe('2026-10-22T04:59:00.000Z');
  });

  it('racha cortada: se puede recuperar con un reto dentro de la ventana', async () => {
    const s = await view({ 2: { activities: 1 }, 3: { activities: 1 }, 4: { activities: 1 } });
    expect(s).toMatchObject({
      current: 0,
      status: 'broken',
      recovery: { lost: 3, until: addDays(d(2), 3) },
    });
  });

  it('los días recuperados aparecen como tales', async () => {
    const s = await view(
      { 0: { challenges: 1 }, 2: { activities: 1 } },
      { streak_bridged: [d(1)] },
    );
    expect(s.current).toBe(2);
    expect(s.days.map((x) => x.recovered)).toEqual([false, true, false]);
  });

  it('sin WhatsApp si está en el grupo de control o se dio de baja', async () => {
    expect((await view({ 0: {} }, { holdout: true })).whatsapp).toBe(false);
    expect((await view({ 0: {} }, { exited: true })).whatsapp).toBe(false);
  });
});
