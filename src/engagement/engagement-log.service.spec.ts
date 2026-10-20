import { ConfigService } from '@nestjs/config';
import { EngagementLogService, EngagementEntry } from './engagement-log.service';
import { holdoutBucket } from './engagement-policy';

const ENTRY: EngagementEntry = {
  dedupeKey: 'weekly_report:u1:org1:2026-10-19',
  kind: 'weekly_report',
  userId: 'u1',
  organizationId: 'org1',
  template: 'reporte_semanal_progreso',
  phone: '573000000000',
};

function chain(value: unknown) {
  const c: any = {
    sort: jest.fn(() => c),
    select: jest.fn(() => c),
    lean: jest.fn(() => c),
    exec: jest.fn().mockResolvedValue(value),
  };
  return c;
}

function createModel() {
  return {
    findOne: jest.fn(() => chain(null)),
    findOneAndUpdate: jest.fn(() => chain(null)),
    create: jest.fn().mockResolvedValue({ _id: 'new-id' }),
    updateOne: jest.fn(() => chain({})),
    countDocuments: jest.fn(() => chain(0)),
  };
}

function createService(
  model: ReturnType<typeof createModel>,
  env: Record<string, string> = {},
) {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return new EngagementLogService(model as any, config);
}

describe('EngagementLogService respuestas', () => {
  it('guarda la primera respuesta en el último envío por WhatsApp', async () => {
    const model = createModel();
    model.findOne.mockReturnValue(
      chain({ _id: 'm1', kind: 'inactivity_reminder', replied_at: null }),
    );
    const service = createService(model);

    await expect(service.markReply('+57 313 273 5116', 'ok')).resolves.toBe(
      'inactivity_reminder',
    );
    // Se busca por los últimos 10 dígitos, solo envíos por WhatsApp
    expect(model.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ phone_tail: '3132735116', status: 'sent' }),
    );
    expect(model.updateOne).toHaveBeenCalledWith(
      { _id: 'm1', replied_at: null },
      { $set: expect.objectContaining({ reply_text: 'ok' }) },
    );
  });

  it('no sobrescribe una respuesta anterior', async () => {
    const model = createModel();
    model.findOne.mockReturnValue(
      chain({ _id: 'm1', kind: 'weekly_report', replied_at: new Date() }),
    );

    await expect(
      createService(model).markReply('573132735116', 'otra'),
    ).resolves.toBe('weekly_report');
    expect(model.updateOne).not.toHaveBeenCalled();
  });

  it('devuelve null si el número no recibió nada reciente', async () => {
    const model = createModel();
    await expect(
      createService(model).markReply('573132735116', 'hola'),
    ).resolves.toBeNull();
  });
});

describe('EngagementLogService clics y estados de Meta', () => {
  const ID = '507f191e810c19729de860eb';

  it('registra el primer clic de un ref válido', async () => {
    const model = createModel();
    model.updateOne.mockReturnValue(chain({ modifiedCount: 1 }));

    await expect(createService(model).markClick(ID)).resolves.toBe(true);
    expect(model.updateOne).toHaveBeenCalledWith(
      { _id: expect.anything(), clicked_at: null },
      { $set: { clicked_at: expect.any(Date) } },
    );
  });

  it('ignora refs que no son ids de envío (p. ej. el de prueba)', async () => {
    const model = createModel();
    await expect(createService(model).markClick('test')).resolves.toBe(false);
    expect(model.updateOne).not.toHaveBeenCalled();
  });

  it('el estado solo avanza: delivered no pisa un read', async () => {
    const model = createModel();
    model.updateOne.mockReturnValue(chain({ matchedCount: 1 }));

    await createService(model).markMetaStatus({
      wamid: 'w1',
      status: 'delivered',
    });
    expect(model.updateOne).toHaveBeenCalledWith(
      { wamid: 'w1', meta_status: { $in: [null, 'sent'] } },
      { $set: expect.objectContaining({ meta_status: 'delivered' }) },
    );
  });

  it('leído también completa la fecha de entrega si faltaba', async () => {
    const model = createModel();
    model.updateOne.mockReturnValue(chain({ matchedCount: 1 }));

    await createService(model).markMetaStatus({ wamid: 'w1', status: 'read' });
    expect(model.updateOne).toHaveBeenCalledWith(
      { wamid: 'w1', delivered_at: null },
      { $set: { delivered_at: expect.any(Date) } },
    );
  });

  it('guarda el error de un fallo de entrega', async () => {
    const model = createModel();
    model.updateOne.mockReturnValue(chain({ matchedCount: 1 }));

    await createService(model).markMetaStatus({
      wamid: 'w1',
      status: 'failed',
      error: '131049 Ecosystem engagement',
    });
    expect(model.updateOne).toHaveBeenCalledWith(
      { wamid: 'w1' },
      {
        $set: {
          meta_status: 'failed',
          meta_error: '131049 Ecosystem engagement',
        },
      },
    );
  });

  it('devuelve false si el wamid no es de un envío registrado', async () => {
    const model: any = createModel();
    model.updateOne.mockReturnValue(chain({ matchedCount: 0 }));
    model.exists = jest.fn(() => chain(null));

    await expect(
      createService(model).markMetaStatus({ wamid: 'otro', status: 'read' }),
    ).resolves.toBe(false);
  });
});

describe('EngagementLogService.deliver', () => {
  it('envía, registra pending y cierra con el resultado', async () => {
    const model = createModel();
    const service = createService(model);
    const send = jest
      .fn()
      .mockResolvedValue({ result: 'sent', messageId: 'wamid.1' });

    await expect(service.deliver(ENTRY, send)).resolves.toBe('sent');

    expect(send).toHaveBeenCalledTimes(1);
    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupe_key: ENTRY.dedupeKey,
        status: 'pending',
        user_id: 'u1',
      }),
    );
    expect(model.updateOne).toHaveBeenCalledWith(
      { _id: 'new-id' },
      {
        $set: expect.objectContaining({
          status: 'sent',
          wamid: 'wamid.1',
          meta_status: 'sent',
          click_tracked: false,
        }),
      },
    );
    // El envío recibe el id del registro para el ?ref= del enlace
    expect(send).toHaveBeenCalledWith('new-id');
  });

  it('con ENGAGEMENT_CLICK_REF agrega ?ref= al enlace y lo marca medible', async () => {
    const model = createModel();
    const service = createService(model, { ENGAGEMENT_CLICK_REF: 'true' });
    expect(service.withClickRef('org1/course/ev1', 'abc')).toBe(
      'org1/course/ev1?ref=abc',
    );
    expect(service.withClickRef('org1/x?a=1', 'abc')).toBe('org1/x?a=1&ref=abc');

    await service.deliver(ENTRY, async () => ({
      result: 'sent',
      messageId: null,
    }));
    expect(model.updateOne).toHaveBeenCalledWith(
      { _id: 'new-id' },
      { $set: expect.objectContaining({ click_tracked: true }) },
    );
  });

  it('sin ENGAGEMENT_CLICK_REF el enlace queda igual', () => {
    expect(createService(createModel()).withClickRef('org1/x', 'abc')).toBe(
      'org1/x',
    );
  });

  it('no reenvía una clave ya registrada', async () => {
    const model = createModel();
    model.findOne.mockReturnValue(chain({ _id: 'x', status: 'sent' }));
    const send = jest.fn();

    await expect(createService(model).deliver(ENTRY, send)).resolves.toBe(
      'duplicate',
    );
    expect(send).not.toHaveBeenCalled();
    expect(model.create).not.toHaveBeenCalled();
  });

  it('trata como duplicado la carrera por la misma clave (índice único)', async () => {
    const model = createModel();
    model.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    const send = jest.fn();

    await expect(createService(model).deliver(ENTRY, send)).resolves.toBe(
      'duplicate',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('reintenta una clave que había fallado', async () => {
    const model = createModel();
    model.findOne.mockReturnValue(chain({ _id: 'old', status: 'failed' }));
    model.findOneAndUpdate.mockReturnValue(chain({ _id: 'old' }));
    const send = jest
      .fn()
      .mockResolvedValue({ result: 'fallback_email', messageId: null });

    await expect(createService(model).deliver(ENTRY, send)).resolves.toBe(
      'fallback_email',
    );
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'old', status: 'failed' },
      expect.anything(),
      expect.anything(),
    );
    expect(model.updateOne).toHaveBeenCalledWith(
      { _id: 'old' },
      { $set: expect.objectContaining({ status: 'fallback_email' }) },
    );
  });

  it('marca failed y propaga el error del gateway', async () => {
    const model = createModel();
    const send = jest.fn().mockRejectedValue(new Error('gateway caído'));

    await expect(createService(model).deliver(ENTRY, send)).rejects.toThrow(
      'gateway caído',
    );
    expect(model.updateOne).toHaveBeenCalledWith(
      { _id: 'new-id' },
      {
        $set: expect.objectContaining({
          status: 'failed',
          error: 'gateway caído',
        }),
      },
    );
  });

  it('no envía si el estudiante ya alcanzó el tope semanal', async () => {
    const model = createModel();
    model.countDocuments.mockReturnValue(chain(2));
    const send = jest.fn();

    await expect(
      createService(model, { ENGAGEMENT_WEEKLY_CAP: '2' }).deliver(ENTRY, send),
    ).resolves.toBe('capped');
    expect(send).not.toHaveBeenCalled();
    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'capped' }),
    );
  });

  it('no envía al grupo de control, pero lo registra', async () => {
    const model = createModel();
    // Porcentaje justo por encima del bucket del usuario: queda dentro
    const percent = String(holdoutBucket('u1') + 1);
    const send = jest.fn();

    await expect(
      createService(model, { ENGAGEMENT_HOLDOUT_PERCENT: percent }).deliver(
        ENTRY,
        send,
      ),
    ).resolves.toBe('holdout');
    expect(send).not.toHaveBeenCalled();
    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'holdout' }),
    );
  });
});
