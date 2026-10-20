import { EngagementReportService, liftOf } from './engagement-report.service';

const ORG_ID = '507f191e810c19729de860ea';
const EVENT_ID = '507f1f77bcf86cd799439011';
const SESSION_ID = '507f1f77bcf86cd799439099';
const HOUR = 3600 * 1000;

function cursor(rows: unknown[]) {
  const c: any = {
    sort: jest.fn(() => c),
    toArray: jest.fn().mockResolvedValue(rows),
  };
  return c;
}

function createService(
  messages: any[],
  progressEvents: any[],
  activityDays: any[] = [],
  practiceSessions: any[] = [],
) {
  const query: any = {
    sort: jest.fn(() => query),
    limit: jest.fn(() => query),
    lean: jest.fn(() => query),
    exec: jest.fn().mockResolvedValue(messages),
  };
  const messageModel = { find: jest.fn(() => query) };
  const collectionModel = (rows: unknown[]) => ({
    collection: { find: jest.fn(() => cursor(rows)) },
  });
  const progressEventModel = collectionModel(progressEvents);
  const service = new EngagementReportService(
    messageModel as any,
    progressEventModel as any,
    collectionModel([{ _id: EVENT_ID }]) as any,
    collectionModel([]) as any,
    collectionModel([]) as any,
    collectionModel(activityDays) as any,
    collectionModel(practiceSessions) as any,
  );
  return { service, progressEventModel };
}

describe('EngagementReportService.summary', () => {
  // Envíos de hace 10 días: la ventana de 72 h ya se cumplió
  const base = Date.now() - 10 * 24 * HOUR;
  const at = (h: number) => new Date(base + h * HOUR);

  const messages = [
    // Entregado, leído, clic, respondió y avanzó a las 5 h
    {
      _id: 'm1', kind: 'inactivity_reminder', status: 'sent', user_id: 'u1', at: at(0),
      replied_at: at(1), wamid: 'w1', delivered_at: at(0.1), read_at: at(0.5),
      click_tracked: true, clicked_at: at(0.6),
    },
    // Entregado por email, avanzó a las 100 h (fuera de la ventana)
    { _id: 'm2', kind: 'inactivity_reminder', status: 'fallback_email', user_id: 'u2', at: at(0) },
    // Entregado (sin leer), se dio de baja, entró a la plataforma sin avanzar
    {
      _id: 'm3', kind: 'inactivity_reminder', status: 'sent', user_id: 'u3', at: at(0),
      opted_out_at: at(2), wamid: 'w3', delivered_at: at(0.1), click_tracked: true,
    },
    // Grupo de control: uno avanzó por su cuenta
    { _id: 'm4', kind: 'inactivity_reminder', status: 'holdout', user_id: 'u4', at: at(0) },
    { _id: 'm5', kind: 'inactivity_reminder', status: 'holdout', user_id: 'u5', at: at(0) },
    // Otro tipo, falló el envío
    { _id: 'm6', kind: 'weekly_report', status: 'failed', user_id: 'u6', at: at(0) },
  ];
  const progressEvents = [
    { user_id: 'u1', type: 'activity_progress', at: at(5) },
    { user_id: 'u1', type: 'course_completed', at: at(6) },
    { user_id: 'u2', type: 'activity_progress', at: at(100) },
    { user_id: 'u4', type: 'activity_progress', at: at(10) },
    // Avance anterior al envío: no cuenta
    { user_id: 'u3', type: 'activity_progress', at: at(-5) },
  ];
  const activityDays = [
    // u3 entró a las 20 h
    { user_id: 'u3', first_at: at(20), last_at: at(21) },
    // u5 solo entró antes del envío: no cuenta
    { user_id: 'u5', first_at: at(-30), last_at: at(-29) },
  ];

  it('calcula el embudo por tipo y contra el grupo de control', async () => {
    const { service } = createService(messages, progressEvents, activityDays);

    const res = await service.summary(ORG_ID, { windowHours: 72 });
    const inactivity = res.kinds.find((k) => k.kind === 'inactivity_reminder')!;

    expect(inactivity).toMatchObject({
      total: 5,
      sent: 2,
      fallback_email: 1,
      holdout: 2,
      delivered: 3,
      // Estados de Meta: los 2 por WhatsApp tienen wamid
      with_status: 2,
      meta_delivered: 2,
      meta_read: 1,
      read_rate: 50,
      clicked: 1,
      click_tracked: 2,
      click_rate: 50,
      replied: 1,
      // 1 de 2 enviados por WhatsApp (el email no cuenta)
      reply_rate: 50,
      opted_out: 1,
      matured: 3,
      // u1 (avanzó) y u3 (entró sin avanzar)
      returned: 2,
      return_rate: 66.7,
      progressed: 1,
      progress_rate: 33.3,
      completed: 1,
      holdout_matured: 2,
      holdout_returned: 1,
      holdout_progressed: 1,
      holdout_progress_rate: 50,
      small_sample: true,
      practice_started: null,
    });
    expect(inactivity.lift.value).toBe(-16.7);
    expect(inactivity.return_lift.value).toBe(16.7);
    expect(res.kinds.find((k) => k.kind === 'weekly_report')).toMatchObject({
      total: 1,
      failed: 1,
      delivered: 0,
      progress_rate: null,
    });
    expect(res.totals.total).toBe(6);
  });

  it('no cuenta en las tasas los envíos cuya ventana no ha terminado', async () => {
    const recent = [
      {
        _id: 'r1',
        kind: 'weekly_report',
        status: 'sent',
        user_id: 'u1',
        at: new Date(Date.now() - 2 * HOUR),
      },
    ];
    const { service } = createService(recent, []);

    const res = await service.summary(ORG_ID, { windowHours: 72 });

    expect(res.totals).toMatchObject({
      delivered: 1,
      matured: 0,
      progress_rate: null,
    });
  });

  it('solo busca avances en los cursos de la organización', async () => {
    const { service, progressEventModel } = createService(messages, []);
    await service.summary(ORG_ID, {});
    expect(progressEventModel.collection.find).toHaveBeenCalledWith(
      expect.objectContaining({ event_id: { $in: [EVENT_ID] } }),
      expect.anything(),
    );
  });

  it('agrega el resultado de los simulacros', async () => {
    const practice = [
      {
        _id: 'p1', kind: 'practice_review', status: 'sent', user_id: 'u1',
        at: at(0), dedupe_key: `practice:${SESSION_ID}`,
      },
    ];
    const sessions = [
      { _id: SESSION_ID, status: 'completed', started_at: at(1), score: 80 },
    ];
    const { service } = createService(practice, [], [], sessions);

    const res = await service.summary(ORG_ID, {});

    expect(res.kinds[0]).toMatchObject({
      kind: 'practice_review',
      practice_started: 1,
      practice_completed: 1,
      practice_start_rate: 100,
      practice_avg_score: 80,
    });
  });
});

describe('liftOf', () => {
  it('marca como significativa una diferencia grande con muestra grande', () => {
    const lift = liftOf(300, 1000, 200, 1000);
    expect(lift.value).toBe(10);
    expect(lift.ci_low).toBeGreaterThan(0);
    expect(lift.significant).toBe(true);
  });

  it('no marca como significativa la misma diferencia con muestra chica', () => {
    const lift = liftOf(3, 10, 2, 10);
    expect(lift.value).toBe(10);
    expect(lift.ci_low).toBeLessThan(0);
    expect(lift.significant).toBe(false);
  });

  it('sin grupo de control no hay diferencia', () => {
    expect(liftOf(5, 10, 0, 0)).toEqual({
      value: null,
      ci_low: null,
      ci_high: null,
      significant: null,
    });
  });
});
