import { BadRequestException } from '@nestjs/common';
import {
  achievementHoldout,
  achievementProgress,
  achievementText,
  defaultAchievements,
  normalizeAchievements,
  renderAchievementText,
  withAchievementDefaults,
} from './genon-achievements';
import { GenOnAchievementsService } from './genon-achievements.service';

const EV1 = '64f0c0ffee64f0c0ffee0001';

const facts = (over: Record<string, any> = {}) => ({
  completedActivityIds: new Set(['a1', 'a2', 'a3', 'b1']),
  videoActivityIds: new Set(['a1', 'a2', 'b1', 'b2']),
  modules: new Map([
    ['m1', ['a1', 'a2']],
    ['m2', ['a3', 'a4']],
  ]),
  courseActivities: new Map([
    ['c1', ['a1', 'a2', 'a3', 'a4']],
    ['c2', ['b1', 'b2']],
    ['c3', ['z1']],
  ]),
  courseProgress: [100, 49.6, 0],
  bestStreak: 6,
  studyDays: 9,
  challengesPassed: 2,
  ...over,
});

describe('achievementProgress', () => {
  it('cuenta actividades, videos completos, módulos y cursos del programa', () => {
    expect(achievementProgress(facts())).toEqual({
      activitiesCompleted: 4,
      videosCompleted: 3,
      modulesCompleted: 1,
      coursesStarted: 2,
      coursesCompleted: 1,
      courseProgress: 100,
      streakDays: 6,
      studyDays: 9,
      challengesPassed: 2,
    });
  });

  it('un módulo sin actividades no cuenta como terminado; sin cursos el avance es 0', () => {
    const p = achievementProgress(
      facts({ modules: new Map([['vacío', []]]), courseProgress: [] }),
    );
    expect(p.modulesCompleted).toBe(0);
    expect(p.courseProgress).toBe(0);
    expect(p.coursesCompleted).toBe(0);
  });
});

describe('textos de logros', () => {
  it('reemplaza nombre, umbral y singular/plural según el umbral', () => {
    const t = '¡{nombre}, ya terminaste {umbral} {curso|cursos}!';
    expect(renderAchievementText(t, { nombre: 'Dr(a). Ana', umbral: 1 })).toBe(
      '¡Dr(a). Ana, ya terminaste 1 curso!',
    );
    expect(renderAchievementText(t, { nombre: 'Dr(a). Ana', umbral: 3 })).toBe(
      '¡Dr(a). Ana, ya terminaste 3 cursos!',
    );
  });

  it('sin texto propio usa el del tipo', () => {
    expect(
      achievementText(
        { id: 'x', enabled: true, type: 'videosCompleted', threshold: 5, title: 'X' },
        'Dr(a). Luis',
      ),
    ).toBe('¡Dr(a). Luis, ya viste 5 videos completos!');
  });
});

describe('configuración de logros', () => {
  it('programas sin logros: los de por defecto, apagados', () => {
    const cfg = withAchievementDefaults(null);
    expect(cfg.enabled).toBe(false);
    expect(cfg.items.length).toBeGreaterThan(5);
    expect(normalizeAchievements(defaultAchievements()).items).toHaveLength(cfg.items.length);
  });

  it('rechaza claves repetidas, tipos desconocidos y umbrales fuera de rango', () => {
    const item = { id: 'a', type: 'coursesCompleted', threshold: 1, title: 'A' };
    expect(() => normalizeAchievements({ items: [item, item] })).toThrow(BadRequestException);
    expect(() =>
      normalizeAchievements({ items: [{ ...item, type: 'pollsAnswered' }] }),
    ).toThrow(BadRequestException);
    expect(() =>
      normalizeAchievements({ items: [{ ...item, type: 'courseProgress', threshold: 120 }] }),
    ).toThrow(BadRequestException);
    expect(() => normalizeAchievements({ items: [{ ...item, title: ' ' }] })).toThrow(
      BadRequestException,
    );
  });

  it('limita el grupo de control a 0-90 %', () => {
    expect(normalizeAchievements({ holdout_percent: 150, items: [] }).holdout_percent).toBe(90);
    expect(normalizeAchievements({ holdout_percent: -5, items: [] }).holdout_percent).toBe(0);
  });

  it('el grupo de control es estable y respeta el porcentaje', () => {
    expect(achievementHoldout('p1', 'u1', 0)).toBe(false);
    expect(achievementHoldout('p1', 'u1', 100)).toBe(true);
    const inGroup = Array.from({ length: 1000 }, (_, i) => achievementHoldout('p1', `u${i}`, 20))
      .filter(Boolean).length;
    expect(inGroup).toBeGreaterThan(150);
    expect(inGroup).toBeLessThan(250);
    expect(achievementHoldout('p1', 'u7', 20)).toBe(achievementHoldout('p1', 'u7', 20));
  });
});

describe('GenOnAchievementsService', () => {
  const program: any = {
    _id: 'p1',
    name: 'Programa',
    mode: 'live',
    timezone: 'America/Bogota',
    achievements: {
      enabled: true,
      show_to_student: true,
      holdout_percent: 0,
      items: [
        { id: 'first_activity', enabled: true, type: 'activitiesCompleted', threshold: 1, title: 'Primer paso' },
        { id: 'videos_3', enabled: true, type: 'videosCompleted', threshold: 3, title: '3 videos' },
        { id: 'off', enabled: false, type: 'activitiesCompleted', threshold: 1, title: 'Apagado' },
      ],
    },
  };

  function setup(stored: any[] = []) {
    const awards = [...stored];
    const cursor = (rows: any[]) => ({ toArray: async () => rows });
    const awardModel = {
      find: jest.fn(() => ({ lean: () => ({ exec: async () => awards.map((a) => ({ ...a })) }) })),
      insertMany: jest.fn(async (rows: any[]) => {
        rows.forEach((r) => awards.push({ ...r, seen_at: null, created_at: new Date() }));
      }),
      updateMany: jest.fn(() => ({ exec: async () => ({ modifiedCount: 1 }) })),
    };
    const enrollment = { program_id: 'p1', event_id: EV1, user_id: 'u1', organization_id: 'o1' };
    const svc = new GenOnAchievementsService(
      {
        find: () => ({ exec: async () => [program] }),
      } as any,
      { find: () => ({ exec: async () => [enrollment] }) } as any,
      awardModel as any,
      {
        collection: {
          findOne: async () => ({ _id: 'u1', names: 'Ana María' }),
        },
      } as any,
      { collection: { find: () => cursor([{ _id: EV1, name: 'Diabetes' }]) } } as any,
      {
        collection: {
          find: () =>
            cursor([
              { _id: 'a1', event_id: EV1, module_id: 'm1', videos: [{ video_id: 'v' }] },
              { _id: 'a2', event_id: EV1, module_id: 'm1', videos: [{ video_id: 'v' }] },
              { _id: 'a3', event_id: EV1, module_id: 'm1', videos: [] },
            ]),
        },
      } as any,
      {
        collection: {
          find: () => cursor([{ activity_id: 'a1' }, { activity_id: 'a3' }, { activity_id: 'otra' }]),
        },
      } as any,
      { collection: { find: () => cursor([]) } } as any,
      { collection: { find: () => cursor([]) } } as any,
      { onActivityCompleted: jest.fn() } as any,
      { programEventIds: jest.fn(async () => [EV1]), personStreak: jest.fn() } as any,
    );
    return { svc, awardModel, awards };
  }

  it('otorga una sola vez los logros cumplidos (los apagados no)', async () => {
    const { svc, awardModel } = setup();
    const first = await svc.evaluate(program, 'u1');
    expect(first.fresh.map((i) => i.id)).toEqual(['first_activity']);
    expect(first.progress).toMatchObject({ activitiesCompleted: 2, videosCompleted: 1 });
    expect(awardModel.insertMany).toHaveBeenCalledTimes(1);
    const again = await svc.evaluate(program, 'u1');
    expect(again.fresh).toEqual([]);
    expect(awardModel.insertMany).toHaveBeenCalledTimes(1);
  });

  it('«Mis logros»: avance, felicitación con Dr(a). y avisos pendientes', async () => {
    const { svc } = setup();
    const [mine] = await svc.mine('uid-1', { organizationId: 'o1' });
    expect(mine).toMatchObject({ program_id: 'p1', event_name: 'Diabetes', achieved: 1, total: 2 });
    expect(mine.items.find((i) => i.id === 'videos_3')).toMatchObject({
      achieved: false,
      progress: 1,
      threshold: 3,
      text: null,
    });
    expect(mine.celebrate).toEqual([
      {
        id: 'first_activity',
        title: 'Primer paso',
        // Sin texto propio: el del tipo
        text: '¡Dr(a). Ana, ya terminaste 1 actividad!',
      },
    ]);
  });

  it('no muestra los logros a quien cae en el grupo de control', async () => {
    const { svc } = setup();
    const hidden = { ...program, achievements: { ...program.achievements, holdout_percent: 100 } };
    (svc as any).programModel = { find: () => ({ exec: async () => [hidden] }) };
    expect(await svc.mine('uid-1', {})).toEqual([]);
  });
});
