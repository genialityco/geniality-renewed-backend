import { GenOnTriggersService } from './genon-triggers.service';
import { GenOnContextService } from './genon-context.service';
import { defaultProgram, defaultTriggers } from './genon-defaults';
import { streakState, addDays } from './genon-streak';

const NOW = new Date('2026-10-19T05:30:00Z'); // lunes 00:30 en Bogotá
const TODAY = '2026-10-19';
const DAY = 24 * 3600 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

const course = {
  eventId: 'ev1',
  eventName: 'Endocrinología',
  organizationId: 'org1',
  activities: [
    { id: 'a1', name: 'Intro', module_id: 'm1', module_name: 'Módulo 1', module_order: 1, video_seconds: 600 },
    { id: 'a2', name: 'Clase 2', module_id: 'm1', module_name: 'Módulo 1', module_order: 1, video_seconds: 600 },
    { id: 'a3', name: 'Clase 3', module_id: 'm2', module_name: 'Módulo 2', module_order: 2, video_seconds: 600 },
    { id: 'a4', name: 'Clase 4', module_id: 'm2', module_name: 'Módulo 2', module_order: 2, video_seconds: 600 },
  ],
  questions: new Map([
    ['a1', { eligible: 5, topic: 'diagnóstico' }],
    ['a2', { eligible: 5, topic: 'tratamiento' }],
  ]),
};

function service() {
  // Solo los métodos puros del contexto (modulesOf, reviewActivityFor)
  const context = new GenOnContextService(
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  return new GenOnTriggersService(
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    context,
    {} as any,
    {} as any,
  );
}

function scenario(opts: {
  segment?: string;
  completed?: Record<string, number>; // actividad → hace cuántos días
  attempted?: boolean;
  certified?: boolean;
  gating?: any;
  validDays?: number[]; // días atrás con actividad
  weekly?: number;
  cohort?: number[];
  progress?: number;
}) {
  const completedAt = new Map(
    Object.entries(opts.completed || {}).map(([id, n]) => [id, daysAgo(n)]),
  );
  const stats = {
    completedByUser: new Map([['u1', new Set(completedAt.keys())]]),
    completedAt: new Map([['u1', completedAt]]),
  } as any;
  const e = {
    _id: 'e1',
    user_id: 'u1',
    segment: opts.segment || 'active',
    progress: opts.progress ?? 50,
    fired: [],
    streak_risk_week: null,
  } as any;
  const data = {
    today: TODAY,
    quizzes: [{ _id: 'q1', moduleId: 'm1', config: { nota: 70 } }],
    bestScore: new Map(opts.attempted ? [['u1:q1', 80]] : []),
    gating: opts.gating ?? null,
    certified: new Set(opts.certified ? ['u1'] : []),
    weekly: new Map([['u1', opts.weekly ?? 0]]),
    cohort: opts.cohort ?? [],
    streaks: new Map([
      [
        'u1',
        streakState(
          (opts.validDays || []).map((n) => addDays(TODAY, -n)),
          [],
          TODAY,
        ),
      ],
    ]),
    stats,
  };
  const program: any = { ...defaultProgram(), timezone: 'America/Bogota' };
  const keys = (service() as any)
    .dailyCandidates(program, defaultTriggers(), { course, stats }, data, e, NOW)
    .map((c: any) => c.key);
  return keys;
}

describe('GenOnTriggersService: disparadores diarios', () => {
  it('recordatorio de examen: módulo terminado hace 2+ días y sin presentar', () => {
    expect(scenario({ completed: { a1: 5, a2: 3 } })).toContain('exam_reminder');
  });

  it('no recuerda el examen si ya lo presentó o si terminó hace menos de 2 días', () => {
    expect(scenario({ completed: { a1: 5, a2: 3 }, attempted: true })).not.toContain('exam_reminder');
    expect(scenario({ completed: { a1: 5, a2: 1 } })).not.toContain('exam_reminder');
    expect(scenario({ completed: { a1: 5 } })).not.toContain('exam_reminder');
  });

  it('certificado: egresado, reglas cumplidas y sin certificado generado', () => {
    const gating = { certificate_gating_enabled: true, certificate_required_activities: 2 };
    expect(
      scenario({ segment: 'graduated', completed: { a1: 5, a2: 3 }, gating }),
    ).toContain('certificate');
  });

  it('no avisa del certificado si sigue bloqueado o ya lo tiene', () => {
    const gating = { certificate_gating_enabled: true, certificate_required_exams: 1 };
    expect(scenario({ segment: 'graduated', gating })).not.toContain('certificate');
    expect(scenario({ segment: 'graduated' })).not.toContain('certificate');
    expect(
      scenario({
        segment: 'graduated',
        gating: { certificate_gating_enabled: true },
        certified: true,
      }),
    ).not.toContain('certificate');
  });

  it('racha: reconocimiento al cumplir 3 días y aviso de riesgo', () => {
    const keys = scenario({ validDays: [1, 2, 3] });
    expect(keys).toContain('streak_milestone');
    expect(keys).toContain('streak_risk');
  });

  it('racha cortada: ofrece recuperarla si hay actividad para repasar', () => {
    const keys = scenario({ validDays: [2, 3, 4], completed: { a1: 2 } });
    expect(keys).toContain('streak_recovery');
    expect(keys).not.toContain('streak_risk');
  });

  it('los disparadores de racha y semana son solo para activos', () => {
    const keys = scenario({ segment: 'inactive', validDays: [1, 2, 3] });
    expect(keys).not.toContain('streak_milestone');
    expect(keys).not.toContain('streak_risk');
  });

  it('comparación semanal: el lunes, con cohorte suficiente y actividad en la semana', () => {
    const cohort = Array.from({ length: 25 }, (_, i) => i % 3);
    expect(scenario({ weekly: 2, cohort })).toContain('weekly_social');
    expect(scenario({ weekly: 0, cohort })).not.toContain('weekly_social');
    expect(scenario({ weekly: 2, cohort: [1, 2] })).not.toContain('weekly_social');
  });
});

describe('GenOnTriggersService: cola', () => {
  function queueSetup(queue: any[], deliverResult = 'sent') {
    const e = {
      _id: 'e1',
      user_id: 'u1',
      event_id: 'ev1',
      organization_id: 'org1',
      segment: 'active',
      slot: '12:30',
      holdout: false,
      progress: 50,
      challenges: [],
      queue,
    };
    const enrollmentModel = {
      find: jest.fn(() => ({ limit: () => ({ exec: jest.fn().mockResolvedValue([e]) }) })),
      updateOne: jest.fn((..._args: any[]) => ({ exec: jest.fn().mockResolvedValue({}) })),
    };
    const progressEventModel = {
      collection: { findOne: jest.fn().mockResolvedValue(null) },
    };
    const engine = {
      resolvePerson: jest.fn().mockResolvedValue({ phone: '573000000000', consent: true, name: 'Ana', email: 'a@x.com' }),
      deliverTemplate: jest.fn().mockResolvedValue({ result: deliverResult }),
    };
    const context = { forPerson: jest.fn(() => ({ values: { nombre: 'Ana' }, urlSuffix: 'org1/course/ev1' })) };
    const svc = new GenOnTriggersService(
      {} as any,
      enrollmentModel as any,
      {} as any, {} as any, {} as any, {} as any,
      progressEventModel as any,
      context as any,
      engine as any,
      {} as any,
    );
    const program: any = { _id: 'p1', ...defaultProgram(), timezone: 'America/Bogota' };
    const cache = jest.fn().mockResolvedValue({ course, stats: {} });
    return { svc, program, enrollmentModel, engine, cache };
  }

  const item = (key: string, extra: Record<string, any> = {}) => ({
    key,
    dedupe: key,
    template_key: key,
    data: {},
    due_at: new Date(NOW.getTime() - 1000),
    expires_at: new Date(NOW.getTime() + DAY),
    ...extra,
  });

  it('envía primero el de mayor prioridad y deja el resto en cola', async () => {
    const { svc, program, enrollmentModel, engine, cache } = queueSetup([
      item('module_completed'),
      item('exam_reminder', { data: { modulo: 'Módulo 1', url_suffix: 'org1/course/ev1/quiz/q1' } }),
    ]);

    const out = await svc.dispatchQueue(program, defaultTriggers(), NOW, false, 10, cache);

    expect(out[0]).toMatchObject({ step: 'examen', result: 'sent' });
    const params = engine.deliverTemplate.mock.calls[0][3];
    expect(params).toMatchObject({
      templateKey: 'exam_reminder',
      urlSuffix: 'org1/course/ev1/quiz/q1',
      step: 'examen',
    });
    expect(params.values.modulo).toBe('Módulo 1');
    const queue = enrollmentModel.updateOne.mock.calls[0][1].$set.queue;
    expect(queue.map((q: any) => q.key)).toEqual(['module_completed']);
  });

  it('si el tope lo frena, se reintenta al día siguiente', async () => {
    const { svc, program, enrollmentModel, cache } = queueSetup(
      [item('weekly_social', { expires_at: new Date(NOW.getTime() + 3 * DAY) })],
      'capped',
    );

    await svc.dispatchQueue(program, defaultTriggers(), NOW, false, 10, cache);

    const queue = enrollmentModel.updateOne.mock.calls[0][1].$set.queue;
    expect(queue).toHaveLength(1);
    expect(new Date(queue[0].due_at).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('el aviso de riesgo se descarta si ya estudió hoy', async () => {
    const { svc, program, engine, cache } = queueSetup([
      item('streak_risk', { unless_active_today: true }),
    ]);
    (svc as any).progressEventModel.collection.findOne.mockResolvedValue({ _id: 'x' });

    const out = await svc.dispatchQueue(program, defaultTriggers(), NOW, false, 10, cache);

    expect(out[0]).toMatchObject({ result: 'skipped', reason: 'ya tuvo actividad hoy' });
    expect(engine.deliverTemplate).not.toHaveBeenCalled();
  });

  it('el reto del video lleva el id del video en el botón', async () => {
    const { svc, program, engine, cache } = queueSetup([
      item('video_challenge', { data: { video: 'Clase 3', video_id: 'a3', url_suffix: 'org1/activitydetail/a3' } }),
    ]);

    await svc.dispatchQueue(program, defaultTriggers(), NOW, false, 10, cache);

    const params = engine.deliverTemplate.mock.calls[0][3];
    expect(params.actionData).toEqual({ video_id: 'a3' });
    expect(params.values.video).toBe('Clase 3');
    expect(params.values.video_id).toBeUndefined();
  });

  it('descarta los disparadores de activos si la persona dejó de estarlo', async () => {
    const { svc, program, engine, enrollmentModel, cache } = queueSetup([item('weekly_social')]);
    const e = await enrollmentModel.find().limit().exec();
    e[0].segment = 'inactive';

    await svc.dispatchQueue(program, defaultTriggers(), NOW, false, 10, cache);

    expect(engine.deliverTemplate).not.toHaveBeenCalled();
  });
});
