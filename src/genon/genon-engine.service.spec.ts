import { GenOnEngineService } from './genon-engine.service';
import { defaultProgram, DEFAULT_TEMPLATES } from './genon-defaults';
import { extractVariables } from './genon-variables';
import { localDate } from './genon-schedule';

const NOW = new Date('2026-10-21T17:30:00Z'); // miércoles 12:30 en Bogotá
const PHONE = '573132735116';

const exec = (value: unknown) => ({ exec: jest.fn().mockResolvedValue(value) });

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
} = {}) {
  const program: any = {
    _id: 'p1',
    name: 'Piloto',
    organization_ids: ['org1'],
    event_ids: [],
    ...defaultProgram(),
    mode: opts.mode || 'live',
    last_segmented_on: localDate(NOW, 'America/Bogota'),
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
    find: jest.fn(() => ({
      sort: () => ({ limit: () => exec([enrollment]) }),
      select: () => ({ lean: () => exec([{ user_id: 'u1', progress: 0 }]) }),
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

  const service = new GenOnEngineService(
    programModel as any,
    enrollmentModel as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    templates as any,
    context as any,
    {} as any,
    engagementLog as any,
    gateway as any,
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
