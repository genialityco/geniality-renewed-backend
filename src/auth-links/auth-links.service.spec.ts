import { UnauthorizedException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { AuthLinksService } from './auth-links.service';

jest.mock('firebase-admin', () => {
  const createCustomToken = jest.fn().mockResolvedValue('firebase-custom');
  return { auth: () => ({ createCustomToken }) };
});
// users.service inicializa Firebase al importarse
jest.mock('src/users/users.service', () => ({ UsersService: class {} }));

const ORG = '6ada6d2ab4d306c546cb8e38';
const USER = '6ada6d2ab4d306c546cb8e4b';
const BASE = 'https://app.geniality.com.co';

const exec = (value: unknown) => ({ exec: jest.fn().mockResolvedValue(value) });

function setup(opts: {
  membership?: boolean;
  roles?: string[];
  author?: boolean;
  link?: Record<string, any> | null;
} = {}) {
  const linkModel = {
    create: jest.fn().mockResolvedValue({}),
    findOne: jest.fn(() => exec(opts.link ?? null)),
    updateOne: jest.fn(() => exec({})),
  };
  const userModel = {
    findById: jest.fn(() => ({ select: () => ({ lean: () => exec({ uid: 'firebase-uid' }) }) })),
  };
  const organizationUserModel = {
    collection: {
      findOne: jest.fn().mockResolvedValue(opts.membership === false ? null : { _id: 'm1' }),
      find: jest.fn(() => ({
        toArray: jest.fn().mockResolvedValue((opts.roles || ['attendee']).map((rol_id) => ({ rol_id }))),
      })),
    },
  };
  const organizationModel = {
    collection: { findOne: jest.fn().mockResolvedValue(opts.author ? { _id: ORG } : null) },
  };
  const usersService = {
    updateSessionToken: jest.fn().mockResolvedValue({
      sessionToken: 'session-1',
      user: { _id: USER, uid: 'firebase-uid', email: 'a@x.com', sessionTokens: [{ token: 'otro' }] },
    }),
  };
  const service = new AuthLinksService(
    linkModel as any,
    userModel as any,
    organizationUserModel as any,
    organizationModel as any,
    usersService as any,
  );
  return { service, linkModel, usersService };
}

describe('AuthLinksService', () => {
  it('agrega el acceso conservando ?t= y el #', () => {
    expect(AuthLinksService.withToken(`${BASE}/organization/o/activitydetail/a?t=754`, 'tk')).toBe(
      `${BASE}/organization/o/activitydetail/a?t=754&login=tk`,
    );
    expect(AuthLinksService.withToken('o/course/e#m1', 'tk')).toBe('o/course/e?login=tk#m1');
  });

  it('agrega un solo token a los enlaces de la organización y deja los demás', async () => {
    const { service, linkModel } = setup();
    const own = `${BASE}/organization/${ORG}/activitydetail/a1?t=90`;
    const other = `${BASE}/organization/otra/activitydetail/a1`;

    const [text, interactive] = await service.addToMessages(
      [`📺 Repasa _Clase 1_ en el minuto 1:30: ${own}\nOtro: ${other}`, { body: `Sigue: ${own}` }],
      USER,
      ORG,
      'genon',
    );

    expect(linkModel.create).toHaveBeenCalledTimes(1);
    const token = (text as string).match(/login=([\w-]+)/)![1];
    expect(text).toContain(`${own}&login=${token}`);
    expect(text).toContain(`Otro: ${other}\n`.trimEnd());
    expect(text).not.toContain(`${other}?login`);
    expect((interactive as any).body).toBe(`Sigue: ${own}&login=${token}`);
  });

  it('sin enlaces de la plataforma no crea token', async () => {
    const { service, linkModel } = setup();
    const out = await service.addToMessages(['Hola, ¿cómo vas?'], USER, ORG, 'genon');
    expect(out).toEqual(['Hola, ¿cómo vas?']);
    expect(linkModel.create).not.toHaveBeenCalled();
  });

  it('nunca da acceso directo a administradores, autores ni a quien no es miembro', async () => {
    expect(await setup({ roles: ['attendee', 'admin'] }).service.create(USER, ORG, 'genon')).toBeNull();
    expect(await setup({ author: true }).service.create(USER, ORG, 'genon')).toBeNull();
    expect(await setup({ membership: false }).service.create(USER, ORG, 'genon')).toBeNull();
    expect(await setup().service.create(USER, ORG, 'genon')).toMatch(/^[\w-]{32}$/);
  });

  it('canjea un token vigente: token de Firebase y sesión nueva', async () => {
    const { service, usersService, linkModel } = setup({
      link: { _id: 'l1', user_id: USER, organization_id: ORG, expires_at: new Date(Date.now() + 60_000) },
    });

    const out = await service.redeem('tk');

    expect(admin.auth().createCustomToken).toHaveBeenCalledWith('firebase-uid');
    expect(usersService.updateSessionToken).toHaveBeenCalledWith('firebase-uid');
    expect(out).toMatchObject({ customToken: 'firebase-custom', sessionToken: 'session-1', organizationId: ORG });
    expect(out.user).toEqual(expect.objectContaining({ _id: USER, uid: 'firebase-uid' }));
    expect(JSON.stringify(out.user)).not.toContain('otro');
    expect(linkModel.updateOne).toHaveBeenCalled();
  });

  it('rechaza un token vencido o si la persona pasó a ser administradora', async () => {
    const expired = setup({
      link: { _id: 'l1', user_id: USER, organization_id: ORG, expires_at: new Date(Date.now() - 1) },
    });
    await expect(expired.service.redeem('tk')).rejects.toThrow(UnauthorizedException);

    const nowAdmin = setup({
      roles: ['admin'],
      link: { _id: 'l1', user_id: USER, organization_id: ORG, expires_at: new Date(Date.now() + 60_000) },
    });
    await expect(nowAdmin.service.redeem('tk')).rejects.toThrow(UnauthorizedException);
    expect(nowAdmin.usersService.updateSessionToken).not.toHaveBeenCalled();
  });
});
