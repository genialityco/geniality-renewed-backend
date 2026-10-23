import { NotFoundException } from '@nestjs/common';
import { GenOnHistoryService } from './genon-history.service';

const NOW = new Date('2026-10-23T17:30:00Z');
const ENROLLMENT_ID = '6adb7852cffc49084f277b4e';

const exec = (value: unknown) => ({ exec: jest.fn().mockResolvedValue(value) });

function setup(enrollment: Record<string, any> | null) {
  const fresh = { _id: 'nuevo', segment: 'abandon', next_step_key: '1.1', next_step_at: NOW };
  const enrollmentModel = {
    findById: jest.fn(() => ({ lean: () => exec(enrollment) })),
    deleteOne: jest.fn(() => exec({ deletedCount: 1 })),
    findOne: jest.fn(() => ({ select: () => ({ lean: () => exec(fresh) }) })),
  };
  const feedbackModel = { deleteMany: jest.fn(() => exec({ deletedCount: 2 })) };
  const engagementLog = { deleteProgramHistory: jest.fn().mockResolvedValue(5) };
  const engine = { resegmentPeople: jest.fn().mockResolvedValue(undefined) };
  const service = new GenOnHistoryService(
    enrollmentModel as any,
    feedbackModel as any,
    {} as any,
    engagementLog as any,
    {} as any,
    engine as any,
  );
  return { service, enrollmentModel, feedbackModel, engagementLog, engine };
}

const enrollment = {
  _id: ENROLLMENT_ID,
  program_id: 'p1',
  event_id: 'ev1',
  user_id: 'u1',
  test: false,
};

describe('GenOnHistoryService: borrar historial', () => {
  it('borra mensajes, comentarios e inscripción y vuelve a segmentar a la persona', async () => {
    const { service, enrollmentModel, feedbackModel, engagementLog, engine } = setup(enrollment);

    const out = await service.clear({ _id: 'p1' } as any, ENROLLMENT_ID, NOW);

    expect(engagementLog.deleteProgramHistory).toHaveBeenCalledWith('u1', 'p1', 'ev1');
    expect(feedbackModel.deleteMany).toHaveBeenCalledWith({ enrollment_id: ENROLLMENT_ID });
    expect(enrollmentModel.deleteOne).toHaveBeenCalledWith({ _id: ENROLLMENT_ID });
    expect(engine.resegmentPeople).toHaveBeenCalledWith(
      { _id: 'p1' },
      'ev1',
      new Set(['u1']),
      NOW,
    );
    expect(out).toMatchObject({
      messages_deleted: 5,
      feedback_deleted: 2,
      enrollment: { segment: 'abandon', next_step_key: '1.1' },
    });
  });

  it('una inscripción de prueba se borra sin volver a segmentar', async () => {
    const { service, engine } = setup({ ...enrollment, test: true });

    const out = await service.clear({ _id: 'p1' } as any, ENROLLMENT_ID, NOW);

    expect(engine.resegmentPeople).not.toHaveBeenCalled();
    expect(out.enrollment).toBeNull();
  });

  it('no borra nada si la inscripción es de otro programa', async () => {
    const { service, engagementLog } = setup({ ...enrollment, program_id: 'otro' });

    await expect(service.clear({ _id: 'p1' } as any, ENROLLMENT_ID, NOW)).rejects.toThrow(
      NotFoundException,
    );
    expect(engagementLog.deleteProgramHistory).not.toHaveBeenCalled();
  });
});
