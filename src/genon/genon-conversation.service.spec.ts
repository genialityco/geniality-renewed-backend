import { GenOnConversationService } from './genon-conversation.service';
import { defaultChallenge, defaultFlows, defaultReplies } from './genon-defaults';

const PHONE = '573132735116';
const ENROLLMENT_ID = '507f191e810c19729de860aa';
const ACTIVITY_1 = '507f191e810c19729de860a1';
const ACTIVITY_2 = '507f191e810c19729de860a2';

const exec = (value: unknown) => ({ exec: jest.fn().mockResolvedValue(value) });

function setup(overrides: { enrollment?: Record<string, any> } = {}) {
  const program = {
    _id: 'p1',
    flows: defaultFlows(),
    replies: defaultReplies(),
    challenge: defaultChallenge(),
    courses: { ev1: { challenge_activity_ids: [ACTIVITY_1], activity_minutes: {} } },
    default_activity_minutes: 15,
  };
  const enrollment = {
    _id: ENROLLMENT_ID,
    program_id: 'p1',
    organization_id: 'org1',
    event_id: 'ev1',
    user_id: 'u1',
    segment: 'abandon',
    last_step_key: '1.1',
    progress: 0,
    phone_tail: PHONE.slice(-10),
    test: false,
    challenges: [],
    ...overrides.enrollment,
  };
  const course = {
    eventId: 'ev1',
    eventName: 'Endocrinología',
    organizationId: 'org1',
    activities: [
      { id: ACTIVITY_1, name: 'Introducción', module_id: null, module_name: null, module_order: null, video_seconds: 600 },
      { id: ACTIVITY_2, name: 'Fisiopatología', module_id: null, module_name: null, module_order: null, video_seconds: 900 },
    ],
    questions: new Map([[ACTIVITY_1, { eligible: 5, topic: 'diagnóstico' }]]),
  };

  const programModel = { findById: jest.fn(() => exec(program)) };
  const enrollmentModel = {
    findById: jest.fn((..._args: any[]) => exec(enrollment)),
    findOne: jest.fn(() => ({ sort: () => exec(null) })),
    updateOne: jest.fn((..._args: any[]) => exec({})),
  };
  const feedbackModel = { create: jest.fn().mockResolvedValue({}) };
  const context = {
    loadCourse: jest.fn().mockResolvedValue(course),
    loadStats: jest.fn().mockResolvedValue({
      completedByUser: new Map(),
      completedAt: new Map(),
      graduated: 0,
      advanced7d: 0,
      advanced14d: 0,
      fromModule: new Map(),
    }),
    forPerson: jest.fn(() => ({
      values: { nombre: 'Ana', link: 'https://x/act', min_actividad: 10, num_preguntas: 3, correo: 'ana@x.com', curso: 'Endocrinología' },
      metrics: {},
    })),
    minutesFor: jest.fn(() => 10),
    challengeActivityFor: jest.fn(() => course.activities[0]),
  };
  const attendees = { createOrUpdate: jest.fn().mockResolvedValue({}) };
  const optOut = { optOutByPhone: jest.fn().mockResolvedValue(1) };
  const engagementLog = { markOptOut: jest.fn().mockResolvedValue(undefined) };
  const triggers = { applyChallengeToStreak: jest.fn().mockResolvedValue(4) };
  const engine = {
    resolvePerson: jest.fn().mockResolvedValue({ name: 'Ana Pérez', email: 'ana@x.com', phone: PHONE, consent: true }),
  };

  const service = new GenOnConversationService(
    programModel as any,
    enrollmentModel as any,
    feedbackModel as any,
    {} as any,
    { registerHandler: jest.fn() } as any,
    { registerFinishHook: jest.fn(), startChallenge: jest.fn() } as any,
    { usedQuestionIds: jest.fn().mockResolvedValue(new Set()) } as any,
    attendees as any,
    optOut as any,
    engagementLog as any,
    context as any,
    engine as any,
    triggers as any,
  );
  return { service, enrollmentModel, feedbackModel, attendees, optOut, triggers };
}

const session = (test = false) =>
  ({
    user_id: 'u1',
    organization_id: 'org1',
    genon: {
      program_id: 'p1',
      enrollment_id: ENROLLMENT_ID,
      step: '1.3',
      activity_id: ACTIVITY_1,
      pass_percent: 100,
      test,
    },
  }) as any;

describe('GenOnConversationService: cierre del reto', () => {
  it('si acierta todo, marca la actividad y pasa a activos', async () => {
    const { service, attendees, enrollmentModel } = setup();

    const text = await service.onChallengeFinished(session(), {
      status: 'completed',
      answered: 3,
      correct: 3,
      total: 3,
      score: 100,
    });

    expect(attendees.createOrUpdate).toHaveBeenCalledWith('u1', ACTIVITY_1, 100);
    expect(text).toContain('Acertaste 3 de 3');
    expect(text).toContain('Fisiopatología');
    const [, update] = enrollmentModel.updateOne.mock.calls[0];
    expect(update.$set.segment).toBe('active');
    expect(update.$push.challenges).toMatchObject({ passed: true, correct: 3 });
  });

  it('si falla, no marca nada y envía el enlace para repasar', async () => {
    const { service, attendees, enrollmentModel } = setup();

    const text = await service.onChallengeFinished(session(), {
      status: 'completed',
      answered: 3,
      correct: 2,
      total: 3,
      score: 67,
    });

    expect(attendees.createOrUpdate).not.toHaveBeenCalled();
    expect(text).toContain('Acertaste 2 de 3');
    expect(text).toContain(`/organization/org1/activitydetail/${ACTIVITY_1}`);
    const [, update] = enrollmentModel.updateOne.mock.calls[0];
    expect(update.$set).toBeUndefined();
    expect(update.$push.challenges).toMatchObject({ passed: false });
  });

  it('en una prueba no marca la actividad aunque apruebe', async () => {
    const { service, attendees } = setup({ enrollment: { test: true } });

    const text = await service.onChallengeFinished(session(true), {
      status: 'completed',
      answered: 3,
      correct: 3,
      total: 3,
      score: 100,
    });

    expect(attendees.createOrUpdate).not.toHaveBeenCalled();
    expect(text).toContain('Prueba');
  });

  it('un reto cancelado usa el cierre normal del simulacro', async () => {
    const { service } = setup();
    await expect(
      service.onChallengeFinished(session(), {
        status: 'cancelled',
        answered: 1,
        correct: 1,
        total: 3,
        score: 100,
      }),
    ).resolves.toBeNull();
  });
});

describe('GenOnConversationService: botones', () => {
  it('reconoce sus botones', async () => {
    const { service } = setup();
    await expect(service.matches(PHONE, 'x', `gn:${ENROLLMENT_ID}:reply:soon`)).resolves.toBe(true);
    await expect(service.matches(PHONE, 'hola')).resolves.toBe(false);
  });

  it('"No era lo que esperaba" detiene la secuencia y espera el comentario', async () => {
    const { service, enrollmentModel } = setup();

    const replies = await service.handle(PHONE, 'No era lo que esperaba', `gn:${ENROLLMENT_ID}:reply:not_expected`);

    expect(replies?.[0]).toContain('¿Qué esperabas encontrar?');
    const [, update] = enrollmentModel.updateOne.mock.calls[0];
    expect(update.$set).toMatchObject({
      awaiting_feedback: true,
      exited: true,
      exit_reason: 'not_expected',
      abandon_reason: 'not_expected',
    });
  });

  it('"Problemas para ingresar" abre un caso de soporte', async () => {
    const { service, feedbackModel } = setup();

    const replies = await service.handle(PHONE, 'x', `gn:${ENROLLMENT_ID}:reply:access`);

    expect(feedbackModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'support' }),
    );
    expect(replies?.[0]).toContain('ana@x.com');
  });

  it('"No he tenido tiempo" ofrece el reto con botones', async () => {
    const { service } = setup();

    const replies = await service.handle(PHONE, 'x', `gn:${ENROLLMENT_ID}:reply:no_time`);

    expect(replies?.[0]).toMatchObject({
      buttons: [
        { id: `gn:${ENROLLMENT_ID}:challenge`, title: 'Quiero el reto' },
        { id: `gn:${ENROLLMENT_ID}:reply:link`, title: 'Voy al curso' },
      ],
    });
  });

  it('la baja da de baja el número, pero no en una prueba', async () => {
    const real = setup();
    await real.service.handle(PHONE, 'x', `gn:${ENROLLMENT_ID}:reply:opt_out`);
    expect(real.optOut.optOutByPhone).toHaveBeenCalledWith(PHONE);

    const test = setup({ enrollment: { test: true } });
    await test.service.handle(PHONE, 'x', `gn:${ENROLLMENT_ID}:reply:opt_out`);
    expect(test.optOut.optOutByPhone).not.toHaveBeenCalled();
  });

  it('ignora el botón si lo toca otro teléfono', async () => {
    const { service } = setup();
    await expect(
      service.handle('573000000000', 'x', `gn:${ENROLLMENT_ID}:reply:soon`),
    ).resolves.toBeNull();
  });
});

describe('GenOnConversationService: retos de la fase 2', () => {
  const kindSession = (kind: 'review' | 'video') =>
    ({ ...session(), genon: { ...session().genon, kind } }) as any;

  it('el reto del video superado marca el video como visto', async () => {
    const { service, attendees, triggers } = setup({ enrollment: { segment: 'active' } });

    const text = await service.onChallengeFinished(kindSession('video'), {
      status: 'completed',
      answered: 1,
      correct: 1,
      total: 1,
      score: 100,
    });

    expect(attendees.createOrUpdate).toHaveBeenCalledWith('u1', ACTIVITY_1, 100);
    expect(triggers.applyChallengeToStreak).toHaveBeenCalled();
    expect(text).toContain('como visto');
  });

  it('el repaso superado no cambia el avance pero cuenta para la racha', async () => {
    const { service, attendees, triggers, enrollmentModel } = setup({
      enrollment: { segment: 'active' },
    });

    const text = await service.onChallengeFinished(kindSession('review'), {
      status: 'completed',
      answered: 3,
      correct: 3,
      total: 3,
      score: 100,
    });

    expect(attendees.createOrUpdate).not.toHaveBeenCalled();
    expect(triggers.applyChallengeToStreak).toHaveBeenCalled();
    expect(text).toContain('Llevas 4 días');
    const [, update] = enrollmentModel.updateOne.mock.calls[0];
    expect(update.$set).toBeUndefined();
    expect(update.$push.challenges).toMatchObject({ kind: 'review', passed: true });
  });

  it('reconoce los botones de los retos nuevos', async () => {
    const { service } = setup();
    await expect(
      service.matches(PHONE, 'x', `gn:${ENROLLMENT_ID}:challenge_video:${ACTIVITY_1}`),
    ).resolves.toBe(true);
  });
});
