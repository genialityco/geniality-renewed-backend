/* eslint-disable prefer-const */
// src/wompi/wompi-webhook.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { createHash } from 'crypto';

function get(obj: any, path: string) {
  return path
    .split('.')
    .reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

@Injectable()
export class WompiWebhookGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();

    const headerChecksum = (
      req.headers['x-event-checksum'] as string | undefined
    )?.toUpperCase();
    if (!headerChecksum)
      throw new UnauthorizedException('Missing x-event-checksum header');

    const body = req.body;
    if (!body?.signature || !body?.data) {
      throw new BadRequestException('Invalid body: signature/data missing');
    }

    const sig = body.signature ?? {};
    let { properties, checksum } = sig as {
      properties?: string[];
      checksum?: string;
      timestamp?: string | number;
    };

    // timestamp: usa signature.timestamp si existe si no, cae a body.timestamp o body.sent_at
    let tsRaw: string | number | undefined =
      (sig as any).timestamp ?? body.timestamp ?? body.sent_at;

    if (
      !Array.isArray(properties) ||
      !properties.every((p) => typeof p === 'string')
    ) {
      throw new BadRequestException('Invalid signature.properties');
    }
    if (typeof tsRaw !== 'string' && typeof tsRaw !== 'number') {
      // log para depurar si llegara a faltar otra vez
      // console.error('[WOMPI GUARD] missing timestamp on body/signature', { sig, bodyKeys: Object.keys(body || {}) });
      throw new BadRequestException('Invalid signature.timestamp');
    }
    const timestamp = String(tsRaw);

    if (typeof checksum !== 'string') {
      throw new BadRequestException('Invalid signature.checksum');
    }

    // (Opcional) anti-replay ±5 min si el timestamp es numérico (epoch ms)
    const tsNum = Number(timestamp);
    if (!Number.isNaN(tsNum) && Math.abs(Date.now() - tsNum) > 5 * 60 * 1000) {
      // console.warn('[WOMPI GUARD] stale timestamp', { tsNum });
      // decide si solo avisa o rechaza
    }

    // secreto por entorno
    const isProd = process.env.WOMPI_ENV === 'production';
    const eventsSecret = isProd
      ? process.env.WOMPI_EVENTS_SECRET_PROD
      : process.env.WOMPI_EVENTS_SECRET_TEST;
    if (!eventsSecret) {
      throw new UnauthorizedException(
        'Events secret not configured for current env',
      );
    }

    // concat EXACTO según properties, tomando datos desde body.data (tal como llega)
    const concatProps = properties
      .map((path) => {
        const v = get(body.data, path);
        return v == null ? '' : String(v);
      })
      .join('');

    const local = createHash('sha256')
      .update(`${concatProps}${timestamp}${eventsSecret}`)
      .digest('hex')
      .toUpperCase();

    const remote = String(checksum).toUpperCase();

    if (local !== remote || local !== headerChecksum) {
      // console.error('[WOMPI GUARD] checksum mismatch', { local, remote, headerChecksum, properties, timestamp });
      throw new UnauthorizedException('Invalid checksum');
    }
    return true;
  }
}
