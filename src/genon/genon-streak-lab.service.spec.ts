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
      insertOne: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({}),
    });
  const enrollment = { _id: new Types.ObjectId(), streak_bridged: ['2026-10-20'] };
  const enrollmentModel = {
    findOne: jest.fn(() => exec(enrollment)),
    collection: { updateOne: jest.fn().mockResolvedValue({}) },
  };
  const engine = {
    loadForUser: jest.fn().mockResolvedValue({
      course: { organizationId: ORG, activities: [{ id: 'a1' }, { id: 'a2' }] },
      stats: {
        completedAt: new Map([
          ['u1', opts.completedAt ?? new Map([['a1', new Date('2026-10-20')], ['a2', new Date('2026-10-22')]])],
        ]),
      },
    }),
  };
  const triggers = { simulateForUser: jest.fn().mockResolvedValue({ streak: { current: 1 } }) };
  const service = new GenOnStreakLabService(
    enrollmentModel as any,
    { collection } as any,
    engine as any,
    triggers as any,
  );
  return { service, collections, enrollmentModel, enrollment, triggers };
}

const program: any = { _id: 'p1' };

describe('GenOnStreakLabService', () => {
  it('solo en organizaciones de prueba', async () => {
    const { service } = setup({ testOrg: false });
    await expect(service.apply(program, 'u1', EV, 'study')).rejects.toThrow('organización de prueba');
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
    const [filter, pipeline] = enrollmentModel.collection.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: enrollment._id });
    expect(pipeline[0].$set.streak_bridged).toEqual({ $literal: ['2026-10-19'] });
  });
});
