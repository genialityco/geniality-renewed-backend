import { Types } from 'mongoose';
import { GenOnStreakLabService } from './genon-streak-lab.service';

const ORG = '6ada6d2ab4d306c546cb8e38';
const EV = '6ada6d2ab4d306c546cb8e39';
const exec = (value: unknown) => ({ exec: jest.fn().mockResolvedValue(value) });

function setup(opts: { testOrg?: boolean; completedAt?: Map<string, Date> } = {}) {
  const collections: Record<string, any> = {};
  const collection = (name: string) =>
    (collections[name] ||= {
      findOne: jest.fn().mockResolvedValue(
        name === 'organizations' && opts.testOrg !== false ? { seed_tag: 'genon-prueba' } : null,
      ),
      countDocuments: jest.fn().mockResolvedValue(opts.testOrg === false ? 0 : 1),
      find: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([{ _id: 'u1', names: 'Ana' }]) })),
      insertOne: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({}),
    });
  const enrollment = { _id: new Types.ObjectId(), streak_bridged: ['2026-10-20'] };
  const enrollmentModel = {
    findOne: jest.fn(() => exec(enrollment)),
    find: jest.fn(() => exec([{ ...enrollment, user_id: 'u1', event_id: EV }])),
    collection: { updateOne: jest.fn().mockResolvedValue({}) },
  };
  const engine = {
    segment: jest.fn().mockResolvedValue({ courses: 1, counts: {} }),
    loadCourseCache: jest.fn().mockResolvedValue({
      course: { activities: [{ id: 'a1' }] },
      stats: { completedAt: new Map([['u1', new Map([['a1', new Date('2026-10-20')]])]]) },
    }),
    loadForUser: jest.fn().mockResolvedValue({
      course: { organizationId: ORG, activities: [{ id: 'a1' }, { id: 'a2' }] },
      stats: {
        completedAt: new Map([
          ['u1', opts.completedAt ?? new Map([['a1', new Date('2026-10-20')], ['a2', new Date('2026-10-22')]])],
        ]),
      },
    }),
  };
  const triggers = {
    simulateForUser: jest.fn().mockResolvedValue({ streak: { current: 1 } }),
    programEventIds: jest.fn().mockResolvedValue([EV, 'ev2']),
  };
  const service = new GenOnStreakLabService(
    enrollmentModel as any,
    { collection } as any,
    engine as any,
    triggers as any,
  );
  return { service, collections, enrollmentModel, enrollment, triggers, engine };
}

const program: any = { _id: 'p1' };

describe('GenOnStreakLabService', () => {
  it('solo en organizaciones de prueba', async () => {
    const { service } = setup({ testOrg: false });
    await expect(service.apply(program, 'u1', EV, 'study')).rejects.toThrow('organizaciones de prueba');
  });

  it('estudiar hoy vuelve a terminar su última actividad terminada y devuelve la simulación', async () => {
    const { service, collections, triggers } = setup();
    const res = await service.apply(program, 'u1', EV, 'study');
    expect(collections.progress_events.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1', event_id: EV, activity_id: 'a2', type: 'activity_progress', to: 100 }),
    );
    expect(collections.activityattendees.updateOne).toHaveBeenCalled();
    expect(triggers.simulateForUser).toHaveBeenCalledWith(program, 'u1', EV);
    expect(res).toEqual({ streak: { current: 1 } });
  });

  it('sin actividades terminadas no puede estudiar', async () => {
    const { service } = setup({ completedAt: new Map() });
    await expect(service.apply(program, 'u1', EV, 'study')).rejects.toThrow('al menos una actividad');
  });

  it('pasar al día siguiente corre un día atrás sus fechas y los días puenteados', async () => {
    const { service, collections, enrollmentModel, enrollment } = setup();
    await service.apply(program, 'u1', EV, 'next_day');
    for (const name of ['progress_events', 'activityattendees', 'courseattendees', 'useractivities']) {
      expect(collections[name].updateMany).toHaveBeenCalled();
    }
    // La racha es de la persona: se corren todos sus cursos del programa
    expect(collections.progress_events.updateMany.mock.calls[0][0]).toEqual({
      user_id: 'u1',
      event_id: { $in: [EV, 'ev2'] },
    });
    const [filter, pipeline] = enrollmentModel.collection.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: enrollment._id });
    expect(pipeline[0].$set.streak_bridged).toEqual({ $literal: ['2026-10-19'] });
    // El aviso de riesgo se puede volver a probar y la cola de racha se limpia
    expect(pipeline[0].$set.streak_risk_week).toBeNull();
    expect(pipeline[0].$set.fired.$filter).toBeDefined();
    expect(pipeline[0].$set.queue.$filter.cond.$not.$in[1]).toEqual(['streak_milestone', 'streak_risk', 'streak_recovery']);
  });
});

describe('GenOnStreakLabService: todos los inscritos', () => {
  it('solo si todas las organizaciones del programa son de prueba', async () => {
    const { service } = setup({ testOrg: false });
    await expect(service.applyAll({ _id: 'p1', organization_ids: [ORG] } as any, 'next_day')).rejects.toThrow(
      'organizaciones de prueba',
    );
  });

  it('pasar el día a todos corre sus fechas y vuelve a segmentar', async () => {
    const { service, enrollmentModel, engine } = setup();
    const program: any = { _id: 'p1', organization_ids: [ORG] };
    const res = await service.applyAll(program, 'next_day');
    expect(enrollmentModel.collection.updateOne).toHaveBeenCalledTimes(1);
    expect(engine.segment).toHaveBeenCalledWith(program, expect.any(Date));
    expect(res.results).toEqual([{ user_id: 'u1', name: 'Ana', ok: true, reason: null }]);
  });

  it('pasar el día a quien está en dos cursos corre sus fechas una sola vez', async () => {
    const { service, collections, enrollmentModel } = setup();
    const both = [
      { _id: new Types.ObjectId(), user_id: 'u1', event_id: EV, streak_bridged: [] },
      { _id: new Types.ObjectId(), user_id: 'u1', event_id: 'ev2', streak_bridged: [] },
    ];
    enrollmentModel.find.mockReturnValue(exec(both));
    const res = await service.applyAll({ _id: 'p1', organization_ids: [ORG] } as any, 'next_day');
    expect(collections.progress_events.updateMany).toHaveBeenCalledTimes(1);
    expect(enrollmentModel.collection.updateOne).toHaveBeenCalledTimes(2);
    expect(res.results).toHaveLength(1);
  });

  it('estudiar hoy a todos: quien no ha terminado nada se reporta', async () => {
    const { service, collections, engine } = setup();
    engine.loadCourseCache.mockResolvedValue({ course: { activities: [] }, stats: { completedAt: new Map() } });
    const res = await service.applyAll({ _id: 'p1', organization_ids: [ORG] } as any, 'study');
    expect(collections.progress_events?.insertOne).toBeUndefined();
    expect(res.results[0]).toMatchObject({ ok: false, reason: 'no ha terminado ninguna actividad' });
    expect(engine.segment).not.toHaveBeenCalled();
  });
});
