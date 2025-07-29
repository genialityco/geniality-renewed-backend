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
  constructor(private usersService: UsersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const uid = req.user?.uid || req.headers['x-uid'];
    const sessionToken = req.headers['x-session-token'];
    if (!uid || !sessionToken)
      throw new UnauthorizedException('No autenticado');

    const user = await this.usersService.findByFirebaseUid(uid);
    if (!user) throw new UnauthorizedException('No autenticado');

    if (user.sessionToken !== sessionToken) {
      throw new UnauthorizedException('SESSION_EXPIRED');
    }
    return true;
  }
}
