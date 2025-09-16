import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { UsersService } from 'src/users/users.service';

@Injectable()
export class SessionTokenGuard implements CanActivate {
  constructor(private readonly usersService: UsersService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();

    // 1) Permitir preflight CORS
    if (req.method === 'OPTIONS') return true;

    // 2) uid desde middleware de Firebase o headers
    const uid: string | undefined =
      (req.user?.uid as string) ||
      (req.headers['x-uid'] as string) ||
      (req.headers['x_uid'] as string);

    // 3) Token normalizado desde headers
    let token =
      (req.headers['x-session-token'] as string) ||
      (req.headers['x_session_token'] as string) ||
      (req.headers['x-sessiontoken'] as string);
    if (Array.isArray(token)) token = token[0];

    if (!uid || !token) {
      throw new UnauthorizedException('No autenticado');
    }

    // 4) Leer sólo tokens (sin lanzar 404 → normalizamos a 401 aquí)
    const userTokens = await this.usersService.findTokensByUid(String(uid));
    if (!userTokens) {
      throw new UnauthorizedException('No autenticado');
    }

    // 5) Verificación contra tokens activos (nuevo esquema + legado)
    const active = new Set<string>();
    const list = Array.isArray(userTokens.sessionTokens)
      ? userTokens.sessionTokens
      : [];

    for (const entry of list) {
      if (!entry) continue;
      const t = typeof entry === 'string' ? entry : entry.token;
      if (t) active.add(String(t));
    }

    if (userTokens.legacyToken) {
      active.add(String(userTokens.legacyToken));
    }

    if (!active.has(String(token))) {
      throw new UnauthorizedException('SESSION_EXPIRED');
    }

    // (Opcional) Deja disponible en la request
    (req as any).auth = { uid: String(uid), sessionToken: String(token) };

    return true;
  }
}
