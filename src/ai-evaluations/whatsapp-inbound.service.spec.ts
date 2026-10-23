import { WhatsappInboundService } from './whatsapp-inbound.service';

const PHONE = '573132735116';

function createService(overrides: {
  evaluationActive?: boolean;
  practiceSession?: unknown;
  memberships?: number;
  repliedTo?: string | null;
  inboundMessageModel?: unknown;
}) {
  const contactModel = {
    updateOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue({}) })),
  };
  const aiEvaluation = {
    hasActiveSession: jest
      .fn()
      .mockResolvedValue(overrides.evaluationActive ?? false),
    handleMessage: jest.fn().mockResolvedValue('respuesta evaluación'),
  };
  const practice = {
    findActiveSession: jest
      .fn()
      .mockResolvedValue(overrides.practiceSession ?? null),
    handleMessage: jest.fn().mockResolvedValue(['respuesta simulacro']),
    isOwnReply: jest.fn().mockReturnValue(false),
    cancelActive: jest.fn(),
  };
  const whatsapp = {
    sendOutbound: jest.fn().mockResolvedValue(undefined),
    sendText: jest.fn().mockResolvedValue(undefined),
  };
  const optOut = {
    optOutByPhone: jest.fn().mockResolvedValue(overrides.memberships ?? 0),
    optInByPhone: jest.fn().mockResolvedValue(overrides.memberships ?? 0),
  };
  const engagementLog = {
    markReply: jest.fn().mockResolvedValue(overrides.repliedTo ?? null),
    markOptOut: jest.fn().mockResolvedValue(undefined),
  };
  const service = new WhatsappInboundService(
    contactModel as any,
    aiEvaluation as any,
    practice as any,
    whatsapp as any,
    optOut as any,
    engagementLog as any,
    overrides.inboundMessageModel as any,
  );
  return { service, aiEvaluation, practice, whatsapp, optOut, engagementLog };
}

/** Ejecuta el procesamiento de un mensaje y espera a que termine. */
async function receive(service: WhatsappInboundService, text: string) {
  await (service as any).process(PHONE, text);
}

describe('WhatsappInboundService: baja', () => {
  it('da de baja y confirma aunque no haya simulacro activo', async () => {
    const { service, optOut, whatsapp, practice } = createService({
      memberships: 2,
    });

    await receive(service, 'BAJA');

    expect(optOut.optOutByPhone).toHaveBeenCalledWith(PHONE);
    expect(practice.handleMessage).not.toHaveBeenCalled();
    expect(whatsapp.sendOutbound).toHaveBeenCalledWith(
      PHONE,
      expect.stringContaining('no te enviaremos más'),
    );
  });

  it('reconoce la frase sin tildes ni mayúsculas', async () => {
    const { service, optOut } = createService({ memberships: 1 });
    await receive(service, 'No más mensajes');
    expect(optOut.optOutByPhone).toHaveBeenCalledWith(PHONE);
  });

  it('no responde si el número no pertenece a ningún estudiante', async () => {
    const { service, whatsapp, optOut } = createService({ memberships: 0 });

    await receive(service, 'baja');

    expect(optOut.optOutByPhone).toHaveBeenCalled();
    expect(whatsapp.sendOutbound).not.toHaveBeenCalled();
  });

  it('con simulacro activo, además deja que el simulacro lo cancele', async () => {
    const { service, practice, optOut, whatsapp } = createService({
      memberships: 1,
      practiceSession: { _id: 's1', status: 'in_progress' },
    });

    await receive(service, 'baja');

    expect(optOut.optOutByPhone).toHaveBeenCalledWith(PHONE);
    expect(practice.handleMessage).toHaveBeenCalledWith(PHONE, 'baja', undefined);
    expect(whatsapp.sendOutbound).toHaveBeenCalledWith(
      PHONE,
      'respuesta simulacro',
    );
  });

  it('durante una evaluación EV-, "baja" es una respuesta y no una baja', async () => {
    const { service, optOut, aiEvaluation } = createService({
      evaluationActive: true,
      memberships: 1,
    });

    await receive(service, 'baja');

    expect(optOut.optOutByPhone).not.toHaveBeenCalled();
    expect(aiEvaluation.handleMessage).toHaveBeenCalledWith(PHONE, 'baja');
  });

  it('los demás mensajes siguen el ruteo normal', async () => {
    const { service, optOut } = createService({ memberships: 1 });
    await receive(service, 'hola');
    expect(optOut.optOutByPhone).not.toHaveBeenCalled();
  });

  it('marca en la bitácora el envío al que responde la baja', async () => {
    const { service, engagementLog } = createService({ memberships: 1 });
    await receive(service, 'baja');
    expect(engagementLog.markOptOut).toHaveBeenCalledWith(PHONE);
  });
});

describe('WhatsappInboundService: respuestas a mensajes de la plataforma', () => {
  it('registra la respuesta aunque ningún motor la atienda', async () => {
    const { service, engagementLog, whatsapp } = createService({
      repliedTo: 'inactivity_reminder',
    });

    await receive(service, 'gracias, mañana sigo');

    expect(engagementLog.markReply).toHaveBeenCalledWith(
      PHONE,
      'gracias, mañana sigo',
    );
    expect(whatsapp.sendOutbound).not.toHaveBeenCalled();
  });

  it('un fallo al registrar la respuesta no impide procesar el mensaje', async () => {
    const { service, engagementLog, aiEvaluation } = createService({
      evaluationActive: true,
    });
    engagementLog.markReply.mockRejectedValue(new Error('mongo caído'));

    await receive(service, 'mi respuesta');

    expect(aiEvaluation.handleMessage).toHaveBeenCalledWith(
      PHONE,
      'mi respuesta',
    );
  });
});

describe('WhatsappInboundService: VOLVER y manejadores registrados', () => {
  it('VOLVER revierte la baja y confirma', async () => {
    const { service, optOut, whatsapp } = createService({ memberships: 1 });

    await receive(service, 'Volver');

    expect(optOut.optInByPhone).toHaveBeenCalledWith(PHONE);
    expect(whatsapp.sendOutbound).toHaveBeenCalledWith(
      PHONE,
      expect.stringContaining('Bienvenido de vuelta'),
    );
  });

  it('un manejador registrado atiende su mensaje antes que el simulacro', async () => {
    const { service, practice, whatsapp } = createService({
      practiceSession: { _id: 's1', status: 'in_progress' },
    });
    const handler = {
      name: 'genon',
      matches: jest.fn(async (_p: string, _t: string, replyId?: string) =>
        Boolean(replyId?.startsWith('gn:')),
      ),
      handle: jest.fn().mockResolvedValue(['respuesta gen.on']),
    };
    service.registerHandler(handler);

    await (service as any).process(PHONE, 'Lo retomo pronto', 'gn:e1:reply:soon');

    expect(handler.handle).toHaveBeenCalledWith(PHONE, 'Lo retomo pronto', 'gn:e1:reply:soon');
    expect(practice.handleMessage).not.toHaveBeenCalled();
    expect(whatsapp.sendOutbound).toHaveBeenCalledWith(PHONE, 'respuesta gen.on');
  });

  it('si no le corresponde, sigue el ruteo normal', async () => {
    const { service, practice } = createService({
      practiceSession: { _id: 's1', status: 'in_progress' },
    });
    service.registerHandler({
      name: 'genon',
      matches: jest.fn().mockResolvedValue(false),
      handle: jest.fn(),
    });

    await receive(service, 'b');

    expect(practice.handleMessage).toHaveBeenCalled();
  });
});

describe('WhatsappInboundService: una respuesta por mensaje', () => {
  const nowSeconds = () => String(Math.floor(Date.now() / 1000));
  const settle = (service: WhatsappInboundService) =>
    (service as any).phoneQueues.get(PHONE) || Promise.resolve();

  it('ignora el reintento tardío de Meta (más de 10 min)', async () => {
    const { service, engagementLog } = createService({});
    const old = String(Math.floor(Date.now() / 1000) - 30 * 60);

    service.enqueue(PHONE, 'hola', undefined, 'wamid.viejo', old);
    await settle(service);

    expect(engagementLog.markReply).not.toHaveBeenCalled();
  });

  it('no procesa otra vez un mensaje ya registrado (p. ej. tras reiniciar)', async () => {
    const inboundMessageModel = {
      create: jest.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 })),
    };
    const { service, engagementLog } = createService({ inboundMessageModel });

    service.enqueue(PHONE, 'hola', undefined, 'wamid.1', nowSeconds());
    await settle(service);

    expect(inboundMessageModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ wamid: 'wamid.1', phone: PHONE }),
    );
    expect(engagementLog.markReply).not.toHaveBeenCalled();
  });

  it('procesa una sola vez el mismo mensaje aunque llegue dos veces', async () => {
    const inboundMessageModel = { create: jest.fn().mockResolvedValue({}) };
    const { service, engagementLog } = createService({ inboundMessageModel });

    service.enqueue(PHONE, 'hola', undefined, 'wamid.2', nowSeconds());
    service.enqueue(PHONE, 'hola', undefined, 'wamid.2', nowSeconds());
    await settle(service);

    expect(engagementLog.markReply).toHaveBeenCalledTimes(1);
  });
});
