// src/wompi/wompi-webhook.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';

@Injectable()
export class WompiWebhookGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const body = req.body;
    const headerChecksum = (
      req.headers['x-event-checksum'] as string | undefined
    )?.toUpperCase();
    const eventsSecret = process.env.WOMPI_EVENTS_SECRET!;
    if (!body?.signature || !headerChecksum)
      throw new UnauthorizedException('Missing signature');

    const { properties, timestamp, checksum } = body.signature;
    const remote = (checksum as string)?.toUpperCase();

    const concatProps = (properties as string[])
      .map((path) =>
        path.split('.').reduce((acc, key) => acc?.[key], body.data),
      )
      .join('');

    const local = createHash('sha256')
      .update(`${concatProps}${timestamp}${eventsSecret}`)
      .digest('hex')
      .toUpperCase();

    if (local !== remote || local !== headerChecksum)
      throw new UnauthorizedException('Invalid checksum');
    return true;
  }
}
