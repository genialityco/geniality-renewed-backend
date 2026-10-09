import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { NotFoundException } from '@nestjs/common';
import { UserActivityService } from './user-activity.service';
import { UserActivity } from './schemas/user-activity.schema';

describe('UserActivityService — registro de tiempo', () => {
  let service: UserActivityService;
  const model = { updateOne: jest.fn() };
  const matched = (n: number) => ({ matchedCount: n });

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserActivityService,
        { provide: getModelToken(UserActivity.name), useValue: model },
      ],
    }).compile();
    service = module.get(UserActivityService);
  });

  it('suma con $inc a la actividad existente, sin exigir sesión activa', async () => {
    model.updateOne.mockResolvedValueOnce(matched(1));

    await service.updateActivityTime(
      'u1',
      'org1',
      'act1',
      'ev1',
      30_000,
      'Act',
    );

    expect(model.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = model.updateOne.mock.calls[0];
    expect(filter).toEqual({
      user_id: 'u1',
      organization_id: 'org1',
      activities: { $elemMatch: { activity_id: 'act1', event_id: 'ev1' } },
    });
    expect(filter).not.toHaveProperty('is_active');
    expect(update.$inc).toEqual({
      'activities.$.time_spent_ms': 30_000,
      total_activities_time_ms: 30_000,
    });
    expect(update.$set['activities.$.activity_name']).toBe('Act');
  });

  it('agrega la entrada la primera vez, protegida contra duplicados', async () => {
    model.updateOne
      .mockResolvedValueOnce(matched(0))
      .mockResolvedValueOnce(matched(1));

    await service.updateCourseTime('u1', 'org1', 'ev1', 'ev1', 5_000, 'Curso');

    const [filter, update] = model.updateOne.mock.calls[1];
    expect(filter.courses).toEqual({
      $not: { $elemMatch: { course_id: 'ev1', event_id: 'ev1' } },
    });
    expect(update.$push.courses).toMatchObject({
      course_id: 'ev1',
      event_id: 'ev1',
      course_name: 'Curso',
      time_spent_ms: 5_000,
    });
    expect(update.$inc).toEqual({ total_courses_time_ms: 5_000 });
  });

  it('si otro envío agregó la entrada entre medio, vuelve a sumar con $inc', async () => {
    model.updateOne
      .mockResolvedValueOnce(matched(0))
      .mockResolvedValueOnce(matched(0))
      .mockResolvedValueOnce(matched(1));

    await service.updateCourseTime('u1', 'org1', 'ev1', 'ev1', 5_000);

    expect(model.updateOne).toHaveBeenCalledTimes(3);
    expect(model.updateOne.mock.calls[2][1].$inc).toEqual({
      'courses.$.time_spent_ms': 5_000,
      total_courses_time_ms: 5_000,
    });
  });

  it('limita deltas negativos o desproporcionados', async () => {
    model.updateOne.mockResolvedValue(matched(1));

    await service.updateCourseTime(
      'u1',
      'org1',
      'ev1',
      'ev1',
      5 * 60 * 60 * 1000,
    );
    await service.updateCourseTime('u1', 'org1', 'ev1', 'ev1', -10);

    expect(model.updateOne.mock.calls[0][1].$inc.total_courses_time_ms).toBe(
      15 * 60 * 1000,
    );
    expect(model.updateOne.mock.calls[1][1].$inc.total_courses_time_ms).toBe(0);
  });

  it('lanza NotFound si el usuario no tiene registro en la organización', async () => {
    model.updateOne.mockResolvedValue(matched(0));

    await expect(
      service.updateActivityTime('u1', 'org1', 'act1', 'ev1', 1_000),
    ).rejects.toThrow(NotFoundException);
  });
});
