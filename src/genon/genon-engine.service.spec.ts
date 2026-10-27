import { GenOnEngineService } from './genon-engine.service';
import { defaultProgram, DEFAULT_TEMPLATES } from './genon-defaults';
import { extractVariables } from './genon-variables';
import { localDate } from './genon-schedule';

const NOW = new Date('2026-10-21T17:30:00Z'); // miércoles 12:30 en Bogotá
const PHONE = '573132735116';

const exec = (value: unknown) => ({ exec: jest.fn().mockResolvedValue(value) });

/** Filtro de la consulta del despacho (la que pide un toque programado). */
const dispatchQuery = (model: { find: jest.Mock }) =>
  (model.find.mock.calls as any[][]).map((c) => c[0]).find((q) => q && 'next_step_at' in q);

function template(key: string, approved: boolean) {
  const t = DEFAULT_TEMPLATES.find((x) => x.key === key)!;
  return {
    ...t,
    language: 'es',
    version: 1,
    meta_name: approved ? `genon_${key}_v1` : null,
    meta_status: approved ? 'APPROVED' : 'DRAFT',
    approved: approved
      ? {
          meta_name: `genon_${key}_v1`,
          language: 'es',
          body: t.body,
          variables: extractVariables(t.body),
          buttons: t.buttons,
          version: 1,
          approved_at: new Date(),
        }
      : null,
  };
}

function setup(opts: {
  mode?: 'dry_run' | 'live';
  enrollment?: Record<string, any>;
  approved?: boolean;
  metrics?: Record<string, number>;
  phone?: string | null;
  deliverResult?: string;
  variantCounts?: { _id: string; n: number }[];
  /** Avances registrados en progress_events */
  progress?: { user_id: string; event_id: string; at: Date }[];
  /** Cómo queda la inscripción si se resegmenta al despachar (null: se borró) */
  resegmented?: Record<string, any> | null;
  autoLogin?: boolean;
  authLinks?: Record<string, any>;
  /** Inscripciones que lista find().select().lean() (por defecto u1 sin datos) */
  listed?: Record<string, any>[];
} = {}) {
  const program: any = {
    _id: 'p1',
    name: 'Piloto',
    organization_ids: ['org1'],
    event_ids: [],
    ...defaultProgram(),
    mode: opts.mode || 'live',
    last_segmented_on: localDate(NOW, 'America/Bogota'),
    auto_login_links: opts.autoLogin ?? false,
  };
  const enrollment = {
    _id: 'e1',
    program_id: 'p1',
    organization_id: 'org1',
    event_id: 'ev1',
    user_id: 'u1',
    segment: 'abandon',
    segment_since: new Date('2026-10-18T17:30:00Z'),
    last_step_key: null,
    last_step_day: null,
    next_step_key: '1.1',
    next_step_at: NOW,
    slot: '12:30',
    holdout: false,
    progress: 0,
    ...opts.enrollment,
  };

  const programModel = { updateOne: jest.fn(() => exec({})) };
  const enrollmentModel = {
    find: jest.fn((q?: any) => ({
      sort: () => ({ limit: () => exec([enrollment]) }),
      // Sin miembros pendientes de abrir un curso
      select: () => ({
        lean: () => exec(q?.without_course ? [] : opts.listed || [{ user_id: 'u1', progress: 0 }]),
      }),
      // Recarga tras resegmentar
      exec: jest
        .fn()
        .mockResolvedValue(opts.resegmented === null ? [] : [{ ...enrollment, ...opts.resegmented }]),
    })),
    updateOne: jest.fn((..._args: any[]) => exec({})),
    aggregate: jest.fn((..._args: any[]) => exec(opts.variantCounts || [])),
  };
  const templates = {
    byKey: jest.fn(async (key: string) => template(key, opts.approved ?? true)),
  };
  const values = {
    nombre: 'Ana',
    curso: 'Endocrinología',
    min_actividad: 15,
    n_egresados: 170,
    n_activos_semana: 42,
    tema_actividad: 'diagnóstico',
    num_preguntas: 3,
    avance: 0,
    actividad_pendiente: 'Intro',
    actividad_reto: 'Intro',
  };
  const context = {
    loadCourse: jest.fn().mockResolvedValue({ eventId: 'ev1', organizationId: 'org1', activities: [] }),
    loadStats: jest.fn().mockResolvedValue({ completedByUser: new Map() }),
    forPerson: jest.fn(() => ({
      values,
      metrics: { n_egresados: 170, n_activos_semana: 42, n_avanzaron: 0, pct_terminaron_desde_aqui: 0, base_desde_aqui: 0, avance: 0, ...opts.metrics },
      pendingActivity: { id: 'a1', name: 'Intro' },
      challengeActivity: { id: 'a1', name: 'Intro' },
      urlSuffix: 'org1/activitydetail/a1',
    })),
  };
  const engagementLog = {
    deliver: jest.fn(async (_entry: any, send: (ref: string) => Promise<unknown>) => {
      if (opts.deliverResult) return opts.deliverResult;
      if (_entry.dryRun) return 'planned';
      await send('ref1');
      return 'sent';
    }),
    withClickRef: jest.fn((path: string) => path),
  };
  const gateway = {
    sendTemplateComponents: jest.fn().mockResolvedValue({ result: 'sent', messageId: 'w1' }),
  };
  const progressEventModel = {
    collection: {
      find: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue(opts.progress || []) })),
    },
  };
  const eventModel = {
    collection: {
      findOne: jest.fn().mockResolvedValue({ _id: 'ev1', name: 'Curso', organizer_id: 'org1' }),
    },
  };

  const service = new GenOnEngineService(
    programModel as any,
    enrollmentModel as any,
    eventModel as any,
    {} as any,
    {} as any,
    {} as any,
    templates as any,
    context as any,
    {} as any,
    engagementLog as any,
    gateway as any,
    progressEventModel as any,
    opts.authLinks as any,
  );
  jest.spyOn(service, 'resolvePerson').mockResolvedValue({
    userId: 'u1',
    name: 'Ana Pérez',
    email: 'ana@x.com',
    phone: opts.phone === undefined ? PHONE : opts.phone,
    consent: true,
  });
  return { service, program, enrollmentModel, engagementLog, gateway };
}

/** Último $set que se guardó en la inscripción. */
const lastSet = (model: { updateOne: jest.Mock }) =>
  model.updateOne.mock.calls[model.updateOne.mock.calls.length - 1][1].$set;

describe('GenOnEngineService: despacho', () => {
  it('envía el toque con tope, control y paso, y programa el siguiente', async () => {
    const { service, program, enrollmentModel, engagementLog, gateway } = setup();

    const { outcomes } = await service.runProgram(program, NOW);

    expect(outcomes[0]).toMatchObject({ step: '1.1', result: 'sent' });
    expect(engagementLog.deliver.mock.calls[0][0]).toMatchObject({
      kind: 'genon',
      segment: 'abandon',
      step: '1.1',
      weeklyCap: 2,
      holdout: false,
      dryRun: false,
      template: 'genon_abandon_question_v1',
    });
    const sent = gateway.sendTemplateComponents.mock.calls[0][0];
    expect(sent.to).toBe(PHONE);
    // Los botones de respuesta llevan la inscripción y la acción
    expect(JSON.stringify(sent.components)).toContain('gn:e1:reply:no_time');
    const set = lastSet(enrollmentModel);
    expect(set).toMatchObject({ last_step_key: '1.1', next_step_key: '1.2', paused: false });
    // 1.2 es el día 3 desde la entrada al segmento (domingo 18 → miércoles 21)
    expect(localDate(set.next_step_at, 'America/Bogota')).toBe('2026-10-21');
  });

  it('omite el mensaje social si ningún dato supera el umbral', async () => {
    const { service, program, enrollmentModel, engagementLog } = setup({
      enrollment: { next_step_key: '1.2', last_step_key: '1.1', last_step_day: 0 },
      metrics: { n_egresados: 5, n_activos_semana: 3 },
    });

    const { outcomes } = await service.runProgram(program, NOW);

    expect(outcomes[0]).toMatchObject({ step: '1.2', result: 'skipped' });
    expect(engagementLog.deliver).not.toHaveBeenCalled();
    expect(lastSet(enrollmentModel)).toMatchObject({
      last_step_key: '1.2',
      next_step_key: '1.3',
      last_error: 'dato social bajo el umbral',
    });
  });

  it('usa la variante B si la A no cumple el umbral', async () => {
    const { service, program, engagementLog } = setup({
      enrollment: { next_step_key: '1.2', last_step_key: '1.1', last_step_day: 0 },
      metrics: { n_egresados: 5, n_activos_semana: 42 },
    });

    await service.runProgram(program, NOW);

    expect(engagementLog.deliver.mock.calls[0][0].template).toBe('genon_social_week_v1');
  });

  it('en simulación planea lo de más tarde hoy y lo registra a la hora de su franja', async () => {
    const later = new Date(NOW.getTime() + 6.5 * 3600 * 1000); // 19:00 en Bogotá
    const { service, program, enrollmentModel, engagementLog } = setup({
      mode: 'dry_run',
      enrollment: { next_step_at: later, slot: '19:00' },
    });

    await service.runProgram(program, NOW, {
      planUntil: new Date(NOW.getTime() + 10 * 3600 * 1000),
    });

    expect(dispatchQuery(enrollmentModel)).toMatchObject({
      next_step_at: { $lte: new Date(NOW.getTime() + 10 * 3600 * 1000) },
    });
    expect(engagementLog.deliver.mock.calls[0][0]).toMatchObject({ dryRun: true, at: later });
  });

  it('al adelantar a mano envía de verdad lo programado para más tarde, con la hora de ahora', async () => {
    const later = new Date(NOW.getTime() + 6.5 * 3600 * 1000); // 19:00 en Bogotá
    const { service, program, enrollmentModel, engagementLog, gateway } = setup({
      enrollment: { next_step_at: later, slot: '19:00' },
    });

    const outcomes = await service.dispatchAhead(program, NOW, false, 10);

    expect(dispatchQuery(enrollmentModel).next_step_at).toEqual({ $ne: null });
    expect(outcomes[0]).toMatchObject({ step: '1.1', result: 'sent' });
    expect(engagementLog.deliver.mock.calls[0][0]).toMatchObject({ dryRun: false, at: NOW });
    expect(gateway.sendTemplateComponents).toHaveBeenCalled();
  });

  it('con dos variantes posibles asigna la menos usada y la guarda', async () => {
    const { service, program, enrollmentModel, engagementLog } = setup({
      enrollment: { next_step_key: '1.2', last_step_key: '1.1', last_step_day: 0 },
      variantCounts: [
        { _id: 'social_graduates', n: 4 },
        { _id: 'social_week', n: 2 },
      ],
    });

    await service.runProgram(program, NOW);

    expect(engagementLog.deliver.mock.calls[0][0].template).toBe('genon_social_week_v1');
    const pick = enrollmentModel.updateOne.mock.calls.find(
      (c: any[]) => c[1].$set?.['variant_picks.1_2'],
    );
    expect(pick?.[1].$set['variant_picks.1_2']).toMatchObject({
      template_key: 'social_week',
      free: true,
    });
  });

  it('conserva la variante ya asignada mientras cumpla', async () => {
    const { service, program, enrollmentModel, engagementLog } = setup({
      enrollment: {
        next_step_key: '1.2',
        last_step_key: '1.1',
        last_step_day: 0,
        variant_picks: { '1_2': { template_key: 'social_graduates', free: true } },
      },
      variantCounts: [{ _id: 'social_graduates', n: 9 }],
    });

    await service.runProgram(program, NOW);

    expect(engagementLog.deliver.mock.calls[0][0].template).toBe('genon_social_graduates_v1');
    expect(enrollmentModel.aggregate).not.toHaveBeenCalled();
  });

  it('en activo no envía una plantilla sin aprobar y reintenta mañana', async () => {
    const { service, program, enrollmentModel, engagementLog } = setup({ approved: false });

    const { outcomes } = await service.runProgram(program, NOW);

    expect(outcomes[0].result).toBe('skipped');
    expect(engagementLog.deliver).not.toHaveBeenCalled();
    const set = lastSet(enrollmentModel);
    expect(set.last_error).toMatch(/sin aprobar/);
    expect(localDate(set.next_step_at, 'America/Bogota')).toBe('2026-10-22');
  });

  it('en simulación usa el borrador y no envía nada', async () => {
    const { service, program, engagementLog, gateway } = setup({
      mode: 'dry_run',
      approved: false,
    });

    const { outcomes } = await service.runProgram(program, NOW);

    expect(outcomes[0].result).toBe('planned');
    expect(engagementLog.deliver.mock.calls[0][0].dryRun).toBe(true);
    expect(gateway.sendTemplateComponents).not.toHaveBeenCalled();
  });

  it('si el tope semanal lo frena, el mismo toque pasa al día siguiente', async () => {
    const { service, program, enrollmentModel } = setup({ deliverResult: 'capped' });

    const { outcomes } = await service.runProgram(program, NOW);

    expect(outcomes[0].result).toBe('capped');
    const set = lastSet(enrollmentModel);
    expect(set.last_step_key).toBeUndefined();
    expect(localDate(set.next_step_at, 'America/Bogota')).toBe('2026-10-22');
  });

  it('el cierre deja la secuencia en pausa', async () => {
    const { service, program, enrollmentModel } = setup({
      enrollment: { next_step_key: '1.4', last_step_key: '1.3', last_step_day: 7 },
    });

    await service.runProgram(program, NOW);

    expect(lastSet(enrollmentModel)).toMatchObject({
      last_step_key: '1.4',
      paused: true,
      next_step_at: null,
    });
  });

  it('sin teléfono no envía y sigue con la secuencia', async () => {
    const { service, program, engagementLog } = setup({ phone: null });

    const { outcomes } = await service.runProgram(program, NOW);

    expect(outcomes[0]).toMatchObject({ result: 'skipped', reason: 'sin teléfono' });
    expect(engagementLog.deliver).not.toHaveBeenCalled();
  });
});

describe('GenOnEngineService: reprogramación', () => {
  // Segmentado hoy a las 12:30 en Bogotá; su franja de hoy (12:15) ya pasó
  const state = {
    segment: 'abandon',
    segment_since: NOW,
    last_step_key: null,
    last_step_day: null,
  };

  it('con margen, la franja que acaba de pasar sale hoy atrasada', () => {
    const { service, program } = setup();
    const next = (service as any).schedule(program, state, '12:15', NOW, 60 * 60 * 1000);
    expect(next).toEqual({
      next_step_key: '1.1',
      next_step_at: new Date('2026-10-21T17:15:00Z'),
    });
  });

  it('sin margen (o pasado el margen) se corre al día siguiente', () => {
    const { service, program } = setup();
    expect((service as any).schedule(program, state, '12:15', NOW).next_step_at).toEqual(
      new Date('2026-10-22T17:15:00Z'),
    );
    expect(
      (service as any).schedule(program, state, '10:00', NOW, 60 * 60 * 1000).next_step_at,
    ).toEqual(new Date('2026-10-22T15:00:00Z'));
  });
});

describe('GenOnEngineService: avance desde la última segmentación', () => {
  const segmentedAt = new Date(NOW.getTime() - 10 * 3600 * 1000);
  const EV = '6ada6d2ab4d306c546cb8e39';

  it('si avanzó y cambió de segmento, se resegmenta y el toque no sale', async () => {
    const { service, program, engagementLog } = setup({
      enrollment: { event_id: EV, segmented_at: segmentedAt },
      progress: [{ user_id: 'u1', event_id: EV, at: new Date(NOW.getTime() - 3600 * 1000) }],
      resegmented: { segment: 'active', next_step_key: null, next_step_at: null },
    });
    const segmentEvent = jest.spyOn(service as any, 'segmentEvent').mockResolvedValue({});

    const { outcomes } = await service.runProgram(program, NOW);

    expect(segmentEvent).toHaveBeenCalledWith(program, expect.anything(), NOW, new Set(['u1']));
    expect(outcomes[0]).toMatchObject({ result: 'skipped', reason: 'avanzó en el curso: pasó a active' });
    expect(engagementLog.deliver).not.toHaveBeenCalled();
  });

  it('si al resegmentar su inscripción se borra (ya no es miembro), el toque no sale', async () => {
    const { service, program, engagementLog } = setup({
      enrollment: { event_id: EV, segmented_at: segmentedAt },
      progress: [{ user_id: 'u1', event_id: EV, at: new Date(NOW.getTime() - 3600 * 1000) }],
      resegmented: null,
    });
    jest.spyOn(service as any, 'segmentEvent').mockResolvedValue({});

    const { outcomes } = await service.runProgram(program, NOW);

    expect(outcomes[0]).toMatchObject({ result: 'skipped', reason: 'no es miembro de la organización' });
    expect(engagementLog.deliver).not.toHaveBeenCalled();
  });

  it('sin avance desde la segmentación, envía sin resegmentar', async () => {
    const { service, program } = setup({
      enrollment: { event_id: EV, segmented_at: segmentedAt },
      // Avance anterior a la segmentación: ya contado
      progress: [{ user_id: 'u1', event_id: EV, at: new Date(segmentedAt.getTime() - 1000) }],
    });
    const segmentEvent = jest.spyOn(service as any, 'segmentEvent');

    const { outcomes } = await service.runProgram(program, NOW);

    expect(segmentEvent).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ step: '1.1', result: 'sent' });
  });
});

describe('GenOnEngineService: segmentar a quien avanzó sin toque pendiente', () => {
  const EV = '6ada6d2ab4d306c546cb8e39';
  const segmentedAt = new Date(NOW.getTime() - 3600 * 1000);
  const paused = { user_id: 'u1', event_id: EV, segmented_at: segmentedAt };

  it('en pausa y con avance desde la segmentación: se segmenta en la pasada del cron', async () => {
    const { service, program } = setup({
      listed: [paused],
      progress: [{ user_id: 'u1', event_id: EV, at: new Date(NOW.getTime() - 60 * 1000) }],
    });
    const resegment = jest.spyOn(service, 'resegmentPeople').mockResolvedValue(undefined);

    await service.runProgram(program, NOW);

    expect(resegment).toHaveBeenCalledWith(program, EV, new Set(['u1']), NOW);
  });

  it('también al enviar ya lo programado', async () => {
    const { service, program } = setup({
      listed: [paused],
      progress: [{ user_id: 'u1', event_id: EV, at: new Date(NOW.getTime() - 60 * 1000) }],
    });
    const resegment = jest.spyOn(service, 'resegmentPeople').mockResolvedValue(undefined);

    await service.dispatchAhead(program, NOW, false, 10);

    expect(resegment).toHaveBeenCalledWith(program, EV, new Set(['u1']), NOW);
  });

  it('sin avance desde la segmentación no la toca', async () => {
    const { service, program } = setup({
      listed: [paused],
      progress: [{ user_id: 'u1', event_id: EV, at: new Date(segmentedAt.getTime() - 1000) }],
    });
    const resegment = jest.spyOn(service, 'resegmentPeople').mockResolvedValue(undefined);

    expect(await service.resegmentProgressed(program, NOW)).toBe(0);
    expect(resegment).not.toHaveBeenCalled();
  });
});

describe('GenOnEngineService: acceso directo en los enlaces', () => {
  const authLinks = () => ({
    create: jest.fn().mockResolvedValue('tk'),
    addToText: jest.fn((text: string) => text.replace(/(https:\/\/\S+)/g, '$1?login=tk')),
  });

  it('con el programa activo, el botón y los enlaces llevan el token', async () => {
    const links = authLinks();
    const { service, program } = setup({ autoLogin: true, authLinks: links });

    const out = await (service as any).withAccess(
      program,
      { user_id: 'u1', organization_id: 'org1', test: false },
      {
        values: { nombre: 'Ana', link: 'https://app.geniality.com.co/organization/org1/activitydetail/a1' },
        urlSuffix: 'org1/activitydetail/a1',
        dryRun: false,
      },
    );

    expect(links.create).toHaveBeenCalledWith('u1', 'org1', 'genon');
    expect(out.urlSuffix).toBe('org1/activitydetail/a1?login=tk');
    expect(out.values.link).toContain('?login=tk');
    expect(out.values.nombre).toBe('Ana');
  });

  it('el texto que guarda la bitácora va sin el token', async () => {
    const links = authLinks();
    const { service, program, engagementLog } = setup({ autoLogin: true, authLinks: links });

    await service.runProgram(program, NOW);

    expect(links.create).toHaveBeenCalled();
    expect(engagementLog.deliver.mock.calls[0][0].text).not.toContain('login=');
  });

  it('apagado (por defecto) o en simulación no crea tokens', async () => {
    const off = authLinks();
    await setup({ authLinks: off }).service.runProgram(setup().program, NOW);
    expect(off.create).not.toHaveBeenCalled();

    const dry = authLinks();
    const sim = setup({ autoLogin: true, mode: 'dry_run', authLinks: dry });
    await sim.service.runProgram(sim.program, NOW);
    expect(dry.create).not.toHaveBeenCalled();
  });
});

describe('GenOnEngineService: enviar a la persona', () => {
  const step = () => ({ key: '1.1', day: 0, mechanic: 'abandon_question', variants: [], enabled: true });

  it('envía con su inscripción real, sin tope ni grupo de control, y avanza su secuencia', async () => {
    const { service, program, enrollmentModel, engagementLog, gateway } = setup({
      enrollment: { holdout: true },
    });
    (enrollmentModel as any).findOne = jest.fn(() => exec({ _id: 'e1', user_id: 'u1', organization_id: 'org1', event_id: 'ev1', segment: 'abandon', segment_since: NOW, slot: '12:30', exited: false }));

    const out = await service.sendRealTemplate(program, {
      userId: 'u1',
      eventId: 'ev1',
      templateKey: 'abandon_question',
      values: { nombre: 'Ana', curso: 'Endocrinología' },
      urlSuffix: '',
      step: '1.1',
      advance: { step: step() as any, segment: 'abandon' },
    });

    expect(engagementLog.deliver.mock.calls[0][0]).toMatchObject({
      holdout: false,
      dryRun: false,
      weeklyCap: Number.MAX_SAFE_INTEGER,
      step: '1.1',
    });
    expect(gateway.sendTemplateComponents.mock.calls[0][0].to).toBe(PHONE);
    expect(out).toMatchObject({ result: 'sent', advanced: true });
    expect(lastSet(enrollmentModel)).toMatchObject({ last_step_key: '1.1' });
  });

  it('no avanza la secuencia si el toque es de otro segmento', async () => {
    const { service, program, enrollmentModel } = setup();
    (enrollmentModel as any).findOne = jest.fn(() => exec({ _id: 'e1', user_id: 'u1', organization_id: 'org1', event_id: 'ev1', segment: 'active', exited: false }));

    const out = await service.sendRealTemplate(program, {
      userId: 'u1',
      eventId: 'ev1',
      templateKey: 'abandon_question',
      values: { nombre: 'Ana', curso: 'Endocrinología' },
      urlSuffix: '',
      step: '1.1',
      advance: { step: step() as any, segment: 'abandon' },
    });

    expect(out.advanced).toBe(false);
  });

  it('no envía a quien no tiene consentimiento', async () => {
    const { service, program, enrollmentModel, engagementLog } = setup();
    (enrollmentModel as any).findOne = jest.fn(() => exec({ _id: 'e1', user_id: 'u1', organization_id: 'org1', event_id: 'ev1', segment: 'abandon', exited: false }));
    (service.resolvePerson as jest.Mock).mockResolvedValue({ userId: 'u1', name: 'Ana', email: '', phone: PHONE, consent: false });

    await expect(
      service.sendRealTemplate(program, {
        userId: 'u1',
        eventId: 'ev1',
        templateKey: 'abandon_question',
        values: { nombre: 'Ana', curso: 'Endocrinología' },
        urlSuffix: '',
        step: '1.1',
      }),
    ).rejects.toThrow('consentimiento');
    expect(engagementLog.deliver).not.toHaveBeenCalled();
  });
});

describe('GenOnEngineService: segmentación solo de miembros', () => {
  it('omite a los inscritos sin membresía en la organización y borra su inscripción', async () => {
    const program: any = { _id: 'p1', organization_ids: ['org1'], ...defaultProgram() };
    const row = (user_id: string) => ({
      user_id,
      course_progress: 0,
      enrolled_at: new Date(NOW.getTime() - 10 * 24 * 3600 * 1000),
      last_activity_at: null,
    });
    const enrollmentModel = {
      find: jest.fn(() => exec([])),
      bulkWrite: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn((..._args: any[]) => exec({})),
    };
    const organizationUserModel = {
      collection: {
        find: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([{ user_id: 'u1' }]) })),
      },
    };
    const context = {
      loadCourse: jest.fn().mockResolvedValue({ eventId: 'ev1', organizationId: 'org1', activities: [] }),
      loadStats: jest.fn().mockResolvedValue({ completedByUser: new Map() }),
    };
    const snapshots = { computeEvent: jest.fn().mockResolvedValue({ rows: [row('u1'), row('u2')] }) };
    const service = new GenOnEngineService(
      {} as any,
      enrollmentModel as any,
      {} as any,
      {} as any,
      organizationUserModel as any,
      {} as any,
      {} as any,
      context as any,
      snapshots as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const counts = await (service as any).segmentEvent(program, { _id: 'ev1', organizer_id: 'org1' }, NOW);

    expect(counts).toEqual({ abandon: 1 });
    const ops = enrollmentModel.bulkWrite.mock.calls[0][0];
    expect(ops.map((o: any) => o.updateOne.filter.user_id)).toEqual(['u1']);
    expect(enrollmentModel.deleteMany).toHaveBeenCalledWith({
      program_id: 'p1',
      event_id: 'ev1',
      user_id: { $in: ['u2'] },
      test: false,
    });
  });
});

describe('GenOnEngineService: miembros que aún no abren un curso', () => {
  const DAY = 24 * 3600 * 1000;

  function setupMembers(opts: { entry?: string | null; pending?: string[]; attendees?: any[] } = {}) {
    const program: any = {
      _id: 'p1',
      organization_ids: ['org1'],
      event_ids: [],
      ...defaultProgram(),
      entry_event_id: opts.entry === undefined ? 'ev1' : opts.entry,
    };
    const enrollmentModel = {
      find: jest.fn((q?: any) => ({
        ...exec([]),
        select: () => ({ lean: () => exec(q?.without_course ? (opts.pending || []).map((user_id) => ({ user_id })) : []) }),
      })),
      bulkWrite: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn((..._args: any[]) => exec({})),
    };
    const courseattendees = {
      distinct: jest.fn().mockResolvedValue(['u1']),
      find: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue(opts.attendees || []) })),
    };
    const organizationUserModel = {
      collection: {
        find: jest.fn(() => ({
          toArray: jest.fn().mockResolvedValue([
            { user_id: 'u1', created_at: new Date(NOW.getTime() - 60 * DAY) },
            { user_id: 'u2', created_at: new Date(NOW.getTime() - 1 * DAY) },
            { user_id: 'u3', created_at: new Date(NOW.getTime() - 30 * DAY) },
          ]),
        })),
      },
      db: { collection: jest.fn(() => courseattendees) },
    };
    const eventModel = {
      collection: {
        find: jest.fn(() => ({
          toArray: jest.fn().mockResolvedValue([
            { _id: 'ev1', organizer_id: 'org1' },
            { _id: 'ev2', organizer_id: 'org1' },
          ]),
        })),
      },
    };
    const service = new GenOnEngineService(
      {} as any,
      enrollmentModel as any,
      eventModel as any,
      {} as any,
      organizationUserModel as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, program, enrollmentModel, organizationUserModel };
  }

  it('entran al curso de entrada: en espera los primeros días y luego en abandono', async () => {
    const { service, program, enrollmentModel, organizationUserModel } = setupMembers();
    const events = await service.programEvents(program);

    const counts = await (service as any).segmentWithoutCourse(program, events, NOW);

    // u1 ya abrió un curso del programa: sigue con su inscripción normal
    expect(counts).toEqual({ waiting: 1, abandon: 1 });
    const ops = enrollmentModel.bulkWrite.mock.calls[0][0].map((o: any) => o.updateOne);
    expect(ops.map((o: any) => [o.filter.user_id, o.filter.event_id, o.update.$set.segment])).toEqual([
      ['u2', 'ev1', 'waiting'],
      ['u3', 'ev1', 'abandon'],
    ]);
    expect(ops[0].update.$set).toMatchObject({ without_course: true, progress: 0 });
    // Sin administradores
    expect((organizationUserModel.collection.find.mock.calls as any[][])[0][0].rol_id).toBeDefined();
    // Sale quien abrió un curso, dejó la organización o quedó en otro curso de entrada
    expect(enrollmentModel.deleteMany).toHaveBeenCalledWith({
      program_id: 'p1',
      test: false,
      without_course: true,
      $or: [{ event_id: { $ne: 'ev1' } }, { user_id: { $nin: ['u2', 'u3'] } }],
    });
  });

  it('sin curso de entrada nadie entra así y se borran las que hubiera', async () => {
    const { service, program, enrollmentModel } = setupMembers({ entry: null });

    expect(await (service as any).segmentWithoutCourse(program, [{ _id: 'ev1', organizer_id: 'org1' }], NOW)).toEqual({});
    expect(enrollmentModel.bulkWrite).not.toHaveBeenCalled();
    expect(enrollmentModel.deleteMany).toHaveBeenCalledWith({ program_id: 'p1', test: false, without_course: true });
  });

  it('al abrir otro curso del programa pasa ya a esa inscripción', async () => {
    const { service, program, enrollmentModel } = setupMembers({
      pending: ['u2'],
      attendees: [{ user_id: 'u2', event_id: 'ev2' }],
    });
    const resegment = jest.spyOn(service, 'resegmentPeople').mockResolvedValue();

    await service.resegmentProgressed(program, NOW);

    expect(resegment).toHaveBeenCalledWith(program, 'ev2', new Set(['u2']), NOW);
    expect(enrollmentModel.deleteMany).toHaveBeenCalledWith({
      program_id: 'p1',
      test: false,
      without_course: true,
      user_id: { $in: ['u2'] },
    });
  });
});

describe('GenOnEngineService: actualizar grupos', () => {
  it('segmenta a todos y devuelve solo a quienes cambiaron de grupo', async () => {
    const before = [
      { user_id: '507f191e810c19729de860a1', event_id: 'ev1', segment: 'abandon' },
      { user_id: '507f191e810c19729de860a2', event_id: 'ev1', segment: 'inactive' },
    ];
    const after = [
      { user_id: '507f191e810c19729de860a1', event_id: 'ev1', segment: 'active' },
      { user_id: '507f191e810c19729de860a2', event_id: 'ev1', segment: 'inactive' },
    ];
    const lists = [before, after];
    const enrollmentModel = {
      find: jest.fn(() => ({ select: () => ({ lean: () => exec(lists.shift()) }) })),
    };
    const userModel = {
      collection: {
        find: jest.fn(() => ({
          toArray: jest.fn().mockResolvedValue([{ _id: '507f191e810c19729de860a1', names: 'Sergio' }]),
        })),
      },
    };
    const service = new GenOnEngineService(
      {} as any,
      enrollmentModel as any,
      {} as any,
      {} as any,
      {} as any,
      userModel as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const segment = jest
      .spyOn(service, 'segment')
      .mockResolvedValue({ courses: 1, counts: { active: 1, inactive: 1 } });
    const program: any = { _id: 'p1' };

    const res = await service.regroup(program, NOW);

    expect(segment).toHaveBeenCalledWith(program, NOW);
    expect(res.changed).toEqual([
      { user_id: '507f191e810c19729de860a1', event_id: 'ev1', name: 'Sergio', from: 'abandon', to: 'active' },
    ]);
  });
});
