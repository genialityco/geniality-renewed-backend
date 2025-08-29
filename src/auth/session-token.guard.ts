// src/auth/session-token.guard.ts
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

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();

    // uid puede venir del middleware que valida Firebase o de headers
    const uid = req.user?.uid || req.headers['x-uid'] || req.headers['x_uid']; // por si algún proxy convierte guiones

    // Normaliza el token desde headers
    let incomingToken =
      req.headers['x-session-token'] ||
      req.headers['x_session_token'] ||
      req.headers['x-sessiontoken'];
    if (Array.isArray(incomingToken)) incomingToken = incomingToken[0];

    if (!uid || !incomingToken) {
      throw new UnauthorizedException('No autenticado');
    }

    const user = await this.usersService.findByFirebaseUid(String(uid));
    if (!user) throw new UnauthorizedException('No autenticado');

    // Construye el set de tokens activos (compat con legado)
    const active = new Set<string>();

    // Nuevo esquema: sessionTokens: [{ token, createdAt }]
    const list = Array.isArray((user as any).sessionTokens)
      ? (user as any).sessionTokens
      : [];
    for (const entry of list) {
      if (!entry) continue;
      const t = typeof entry === 'string' ? entry : entry.token;
      if (t) active.add(String(t));
    }

    // Campo legado: sessionToken (string)
    if ((user as any).sessionToken) {
      active.add(String((user as any).sessionToken));
    }

    if (!active.has(String(incomingToken))) {
      // El token enviado no está entre los 2 activos del usuario
      throw new UnauthorizedException('SESSION_EXPIRED');
    }

    return true;
  }
}
