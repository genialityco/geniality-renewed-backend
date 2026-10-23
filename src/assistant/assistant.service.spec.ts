import { AssistantService } from './assistant.service';

const PHONE = '573133057451';
const ORG_A = '6ada6d2ab4d306c546cb8e38';
const ORG_B = '6a4ffd695b809f3cf38d3a64';

const exec = (value: unknown) => ({ exec: jest.fn().mockResolvedValue(value) });

function setup(opts: {
  memberships?: { organization_id: string; user_id: string }[];
  enabledOrgs?: { _id: string; name: string; assistant?: any }[];
  conversation?: Record<string, any>;
  answer?: string;
  authLinks?: Record<string, any>;
} = {}) {
  const conversation = {
    _id: 'c1',
    phone_tail: '3133057451',
    organization_id: null,
    pending_question: null,
    turns: [],
    day: null,
    day_count: 0,
    ...opts.conversation,
  };
  const conversationModel = {
    findOneAndUpdate: jest.fn(() => exec(conversation)),
    updateOne: jest.fn((..._args: any[]) => exec({})),
  };
  const organizationModel = {
    collection: {
      find: jest.fn(() => ({
        toArray: jest.fn().mockResolvedValue(
          (opts.enabledOrgs ?? [{ _id: ORG_A, name: '[PRUEBA] Gen.ON', assistant: { enabled: true } }]),
        ),
      })),
    },
  };
  const optOut = {
    membershipsByPhone: jest.fn().mockResolvedValue(
      (opts.memberships ?? [{ organization_id: ORG_A, user_id: 'u1' }]).map((m) => ({
        ...m,
        properties: { nombres: 'Laura María' },
        whatsapp_opt_out_at: null,
      })),
    ),
  };
  const inbound = { registerHandler: jest.fn(), registerFallback: jest.fn() };
  const gemini = {
    chat: jest.fn().mockResolvedValue({ text: opts.answer ?? 'Llevas 38 %.', calls: [] }),
  };
  const tools = {
    enrollments: jest.fn().mockResolvedValue([{ course: { id: 'ev1', name: 'Hipotiroidismo' } }]),
    run: jest.fn(),
  };
  const service = new AssistantService(
    conversationModel as any,
    organizationModel as any,
    optOut as any,
    inbound as any,
    gemini as any,
    tools as any,
    opts.authLinks as any,
  );
  return { service, conversationModel, gemini, tools, inbound };
}

describe('AssistantService', () => {
  it('se registra como respaldo y para el botón de organización', () => {
    const { service, inbound } = setup();
    service.onModuleInit();
    expect(inbound.registerFallback).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'assistant' }),
    );
    expect(inbound.registerHandler).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'assistant-choice' }),
    );
  });

  it('el respaldo ignora botones de otros flujos', async () => {
    const { service, inbound } = setup();
    service.onModuleInit();
    const fallback = inbound.registerFallback.mock.calls[0][0];
    await expect(fallback.matches(PHONE, 'Opción A', 'pq:x:0:a')).resolves.toBe(false);
    await expect(fallback.matches(PHONE, 'hola', undefined)).resolves.toBe(true);
  });

  it('no responde a un número que no es miembro de una organización con el asistente', async () => {
    const { service, gemini } = setup({ enabledOrgs: [] });
    await expect(service.reply(PHONE, 'hola')).resolves.toBeNull();
    expect(gemini.chat).not.toHaveBeenCalled();
  });

  it('con una sola organización responde con las herramientas atadas a la persona', async () => {
    const { service, gemini, tools, conversationModel } = setup();
    await expect(service.reply(PHONE, '¿cuánto llevo?')).resolves.toEqual(['Llevas 38 %.']);

    const call = gemini.chat.mock.calls[0][0];
    expect(call.system).toContain('[PRUEBA] Gen.ON');
    expect(call.system).toContain('Laura');
    await call.runTool('mis_cursos', {});
    expect(tools.run).toHaveBeenCalledWith(
      { userId: 'u1', organizationId: ORG_A },
      'mis_cursos',
      {},
    );
    const saved = conversationModel.updateOne.mock.calls.at(-1)![1];
    expect(saved.$set).toMatchObject({ organization_id: ORG_A, user_id: 'u1', day_count: 1 });
    expect(saved.$push.turns.$each.map((t: any) => t.role)).toEqual(['user', 'assistant']);
  });

  it('si pertenece a varias, pregunta cuál y guarda la pregunta', async () => {
    const { service, gemini, conversationModel } = setup({
      memberships: [
        { organization_id: ORG_A, user_id: 'u1' },
        { organization_id: ORG_B, user_id: 'u2' },
      ],
      enabledOrgs: [
        { _id: ORG_A, name: '[PRUEBA] Gen.ON', assistant: { enabled: true } },
        { _id: ORG_B, name: 'ACE', assistant: { enabled: true } },
      ],
    });
    const [message] = (await service.reply(PHONE, '¿qué me falta?'))!;
    expect((message as any).list.sections[0].rows.map((r: any) => r.id)).toEqual([
      `as:org:${ORG_A}`,
      `as:org:${ORG_B}`,
    ]);
    expect(gemini.chat).not.toHaveBeenCalled();
    expect(conversationModel.updateOne.mock.calls[0][1].$set.pending_question).toBe('¿qué me falta?');
  });

  it('al elegir organización responde la pregunta que había hecho', async () => {
    const { service, gemini, tools } = setup({
      memberships: [
        { organization_id: ORG_A, user_id: 'u1' },
        { organization_id: ORG_B, user_id: 'u2' },
      ],
      enabledOrgs: [
        { _id: ORG_A, name: '[PRUEBA] Gen.ON', assistant: { enabled: true } },
        { _id: ORG_B, name: 'ACE', assistant: { enabled: true } },
      ],
      conversation: { pending_question: '¿qué me falta?' },
    });
    await service.reply(PHONE, 'ACE', `as:org:${ORG_B}`);
    expect(gemini.chat.mock.calls[0][0].message).toBe('¿qué me falta?');
    await gemini.chat.mock.calls[0][0].runTool('estado_curso', {});
    expect(tools.run.mock.calls[0][0]).toEqual({ userId: 'u2', organizationId: ORG_B });
  });

  it('al llegar al tope diario avisa una vez y luego no responde', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
    const limited = setup({
      enabledOrgs: [{ _id: ORG_A, name: 'Org', assistant: { enabled: true, daily_limit: 2 } }],
      conversation: { organization_id: ORG_A, day: today, day_count: 2 },
    });
    const [msg] = (await limited.service.reply(PHONE, 'hola'))!;
    expect(msg).toContain('límite');
    expect(limited.gemini.chat).not.toHaveBeenCalled();

    const over = setup({
      enabledOrgs: [{ _id: ORG_A, name: 'Org', assistant: { enabled: true, daily_limit: 2 } }],
      conversation: { organization_id: ORG_A, day: today, day_count: 3 },
    });
    await expect(over.service.reply(PHONE, 'hola')).resolves.toBeNull();
  });

  it('si Gemini falla, se disculpa y guarda el turno', async () => {
    const { service, gemini, conversationModel } = setup();
    gemini.chat.mockRejectedValueOnce(new Error('timeout'));
    const [msg] = (await service.reply(PHONE, 'hola'))!;
    expect(msg).toContain('problema');
    expect(conversationModel.updateOne).toHaveBeenCalled();
  });
});

describe('AssistantService: enlaces con acceso directo', () => {
  const LINK = 'https://app.geniality.com.co/organization/6ada6d2ab4d306c546cb8e38/activitydetail/a1?t=90';
  const authLinks = () => ({
    addToMessages: jest.fn(async (msgs: string[]) => msgs.map((m) => m.replace(LINK, `${LINK}&login=tk`))),
  });

  it('la respuesta lleva el acceso directo; la conversación guardada no', async () => {
    const links = authLinks();
    const { service, conversationModel } = setup({ answer: `Repasa aquí: ${LINK}`, authLinks: links });

    const out = await service.reply(PHONE, '¿dónde explican la TSH?');

    expect(out).toEqual([`Repasa aquí: ${LINK}&login=tk`]);
    expect(links.addToMessages).toHaveBeenCalledWith([`Repasa aquí: ${LINK}`], 'u1', ORG_A, 'assistant');
    const saved = conversationModel.updateOne.mock.calls.at(-1)![1];
    expect(saved.$push.turns.$each[1].text).toBe(`Repasa aquí: ${LINK}`);
  });

  it('si la organización lo apaga, los enlaces salen normales', async () => {
    const links = authLinks();
    const { service } = setup({
      answer: `Repasa aquí: ${LINK}`,
      authLinks: links,
      enabledOrgs: [{ _id: ORG_A, name: '[PRUEBA] Gen.ON', assistant: { enabled: true, auto_login_links: false } }],
    });

    await expect(service.reply(PHONE, '¿dónde?')).resolves.toEqual([`Repasa aquí: ${LINK}`]);
    expect(links.addToMessages).not.toHaveBeenCalled();
  });
});
