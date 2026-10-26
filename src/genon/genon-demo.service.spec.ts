import { Types } from 'mongoose';
import { DEMO_TAG, GenOnDemoService, normalizeDemoPhone } from './genon-demo.service';

const EVENT_ID = '6ada6d2ab4d306c546cb8e39';
const ORG_ID = '6ada6d2ab4d306c546cb8e38';
const exec = (value: unknown) => ({ exec: jest.fn().mockResolvedValue(value) });

/** Colección falsa: registra lo que se escribe. */
function fakeCollection(found: { findOne?: any; find?: any[] } = {}) {
  const cursor = (rows: any[]) => ({
    toArray: jest.fn().mockResolvedValue(rows),
    project: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue(rows) })),
    sort: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue(rows) })),
  });
  return {
    findOne: jest.fn().mockResolvedValue(found.findOne ?? null),
    find: jest.fn(() => cursor(found.find ?? [])),
    insertOne: jest.fn().mockResolvedValue({}),
    insertMany: jest.fn().mockResolvedValue({}),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
  };
}

function setup(opts: { mode?: string; testOrg?: boolean; stage?: string | null } = {}) {
  const program: any = {
    _id: 'p1',
    mode: opts.mode ?? 'off',
    flows: {},
    triggers: null,
    courses: {},
  };
  const demo: any = {
    _id: new Types.ObjectId(),
    program_id: 'p1',
    organization_id: ORG_ID,
    event_id: EVENT_ID,
    stage: opts.stage ?? null,
    participants: [
      { user_id: 'u1', name: 'Ana', phone: '573001112233' },
      { user_id: 'u2', name: 'Luis', phone: '573004445566' },
    ],
    sends: [],
    created_at: new Date(),
  };
  const collections: Record<string, ReturnType<typeof fakeCollection>> = {
    organizations: fakeCollection({ findOne: opts.testOrg === false ? {} : { seed_tag: 'genon-prueba' } }),
  };
  const connection = {
    collection: jest.fn((name: string) => (collections[name] ||= fakeCollection())),
  };
  const demoModel = {
    findOne: jest.fn(() => ({ sort: () => exec(null) })),
    create: jest.fn(async (doc: any) => ({ _id: 'd1', ...doc })),
    updateOne: jest.fn(() => exec({})),
    deleteOne: jest.fn(() => exec({})),
  };
  const enrollmentModel = {
    updateMany: jest.fn((..._args: any[]) => exec({})),
    deleteMany: jest.fn((..._args: any[]) => exec({})),
  };
  const feedbackModel = { deleteMany: jest.fn(() => exec({})) };
  const activities = Array.from({ length: 8 }, (_, i) => ({
    id: `a${i}`,
    name: `Actividad ${i}`,
    module_id: `m${Math.floor(i / 2)}`,
    module_name: `Módulo ${Math.floor(i / 2) + 1}`,
    module_order: Math.floor(i / 2) + 1,
  }));
  const context = {
    loadCourse: jest.fn().mockResolvedValue({ eventId: EVENT_ID, eventName: 'Curso', organizationId: ORG_ID, activities }),
    modulesOf: jest.fn(() =>
      [0, 1, 2, 3].map((m) => ({ id: `m${m}`, name: `Módulo ${m + 1}`, order: m + 1, activityIds: [`a${2 * m}`, `a${2 * m + 1}`] })),
    ),
  };
  const engine = {
    programEvents: jest.fn().mockResolvedValue([{ _id: EVENT_ID, organizer_id: ORG_ID }]),
    resegmentPeople: jest.fn().mockResolvedValue(undefined),
    sendRealStep: jest.fn().mockResolvedValue({ template: 'abandon_question' }),
    sendRealTemplate: jest.fn().mockResolvedValue({ template: 'streak_risk' }),
    sendableVersion: jest.fn(),
  };
  const triggers = {
    buildTriggerMessage: jest.fn().mockResolvedValue({
      templateKey: 'streak_risk',
      values: { nombre: 'Ana' },
      urlSuffix: 'x',
      actionData: undefined,
    }),
    templateFor: jest.fn(),
  };
  const service = new GenOnDemoService(
    demoModel as any,
    enrollmentModel as any,
    feedbackModel as any,
    connection as any,
    engine as any,
    triggers as any,
    {} as any,
    context as any,
  );
  return { service, program, demo, collections, demoModel, enrollmentModel, engine, triggers };
}

describe('normalizeDemoPhone', () => {
  it('agrega el indicativo de Colombia a los números de 10 dígitos', () => {
    expect(normalizeDemoPhone('300 111 2233')).toBe('573001112233');
    expect(normalizeDemoPhone('+57 300-111-2233')).toBe('573001112233');
    expect(normalizeDemoPhone('+1 (305) 555-0100')).toBe('13055550100');
  });

  it('rechaza números incompletos', () => {
    expect(() => normalizeDemoPhone('12345')).toThrow('Teléfono inválido');
  });
});

describe('GenOnDemoService', () => {
  it('solo con el programa apagado', async () => {
    const { service, program } = setup({ mode: 'live' });
    await expect(service.create(program, 'uid', {})).rejects.toThrow('Apaga el programa');
  });

  it('solo en una organización de prueba', async () => {
    const { service, program } = setup({ testOrg: false });
    await expect(service.create(program, 'uid', {})).rejects.toThrow('organización de prueba');
  });

  it('crea al participante con su teléfono, consentimiento y la marca de la demostración', async () => {
    const { service, program, demo, collections } = setup();
    await service.addParticipant(program, demo, { name: 'Marta Gómez', phone: '3007778899' });
    const user = collections.users.insertOne.mock.calls[0][0];
    expect(user).toMatchObject({ names: 'Marta Gómez', phone: '573007778899', seed_tag: DEMO_TAG });
    const membership = collections.organizationusers.insertOne.mock.calls[0][0];
    expect(membership).toMatchObject({
      rol_id: 'attendee',
      whatsapp_opt_in: true,
      properties: { nombres: 'Marta', apellidos: 'Gómez', phone: '3007778899', indicativodepais: '57' },
      seed_tag: DEMO_TAG,
    });
    expect(collections.courseattendees.insertOne).toHaveBeenCalled();
  });

  it('no repite un teléfono', async () => {
    const { service, program, demo } = setup();
    await expect(
      service.addParticipant(program, demo, { name: 'Otra', phone: '3001112233' }),
    ).rejects.toThrow('ya está');
  });

  it('preparar "activos" escribe el avance del escenario y deja la conversación en limpio', async () => {
    const { service, program, demo, collections, engine, enrollmentModel } = setup();
    await service.prepareStage(program, demo, 'active');

    // Primero borra lo anterior
    expect(collections.activityattendees.deleteMany).toHaveBeenCalled();
    // 3 actividades seguidas por persona (racha de 3 días hasta ayer), 3/8 = 38 %
    expect(collections.activityattendees.insertMany).toHaveBeenCalledTimes(2);
    expect(collections.activityattendees.insertMany.mock.calls[0][0].map((a: any) => a.activity_id)).toEqual(['a0', 'a1', 'a2']);
    expect(collections.courseattendees.updateOne.mock.calls[0][1].$set.progress).toBe(38);
    expect(engine.resegmentPeople).toHaveBeenCalledWith(program, EVENT_ID, new Set(['u1', 'u2']), expect.any(Date));
    expect(enrollmentModel.updateMany.mock.calls[0][1].$set).toMatchObject({
      exited: false,
      challenges: [],
      fired: [],
      streak: null,
      abandon_reason: null,
    });
    expect(demo.stage).toBe('active');
  });

  it('no envía un paso de otra etapa', async () => {
    const { service, program, demo } = setup({ stage: 'abandon' });
    await expect(service.sendStep(program, demo, 'active:streak_risk')).rejects.toThrow('Prepara primero');
  });

  it('envía a cada participante y sigue si uno falla', async () => {
    const { service, program, demo, engine } = setup({ stage: 'abandon' });
    engine.sendRealStep
      .mockRejectedValueOnce(new Error('sin consentimiento'))
      .mockResolvedValueOnce({ template: 'abandon_question' });
    const { results } = await service.sendStep(program, demo, 'abandon:1.1');
    expect(engine.sendRealStep).toHaveBeenCalledWith(program, 'u1', EVENT_ID, '1.1');
    expect(results.map((r) => [r.name, r.ok, r.error])).toEqual([
      ['Ana', false, 'sin consentimiento'],
      ['Luis', true, null],
    ]);
  });

  it('los disparadores salen con el mensaje armado con los datos de la persona', async () => {
    const { service, program, demo, engine, triggers } = setup({ stage: 'active' });
    await service.sendStep(program, demo, 'active:streak_risk', ['u2']);
    expect(triggers.buildTriggerMessage).toHaveBeenCalledWith(program, 'u2', EVENT_ID, 'streak_risk');
    expect(engine.sendRealTemplate).toHaveBeenCalledTimes(1);
    expect(engine.sendRealTemplate).toHaveBeenCalledWith(
      program,
      expect.objectContaining({ userId: 'u2', templateKey: 'streak_risk', step: '3.4 riesgo' }),
    );
  });

  it('al terminar solo borra usuarios con la marca de la demostración', async () => {
    const { service, program, demo, collections } = setup();
    const marked = new Types.ObjectId();
    demo.participants = [{ user_id: String(marked) }, { user_id: String(new Types.ObjectId()) }];
    collections.users = fakeCollection({ find: [{ _id: marked }] });
    await service.remove(program, demo);
    const filter = collections.users.deleteMany.mock.calls[0][0];
    expect(filter.seed_tag).toBe(DEMO_TAG);
    expect(filter._id.$in.map(String)).toEqual([String(marked), String(marked)]);
  });
});
