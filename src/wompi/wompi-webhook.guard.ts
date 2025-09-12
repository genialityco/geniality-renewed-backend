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

    // Headers vienen normalizados a minúsculas en Node/Nest
    const headerChecksum = (
      req.headers['x-event-checksum'] as string | undefined
    )?.toUpperCase();
    if (!headerChecksum)
      throw new UnauthorizedException('Missing x-event-checksum header');

    const body = req.body;
    if (!body?.signature || !body?.data) {
      throw new BadRequestException('Invalid body: signature/data missing');
    }

    const { properties, timestamp, checksum } = body.signature ?? {};
    if (
      !Array.isArray(properties) ||
      !properties.every((p) => typeof p === 'string')
    ) {
      throw new BadRequestException('Invalid signature.properties');
    }
    if (typeof timestamp !== 'string' && typeof timestamp !== 'number') {
      throw new BadRequestException('Invalid signature.timestamp');
    }
    if (typeof checksum !== 'string') {
      throw new BadRequestException('Invalid signature.checksum');
    }

    // Elegir secret por entorno
    const isProd = process.env.WOMPI_ENV === 'production';
    const eventsSecret = isProd
      ? process.env.WOMPI_EVENTS_SECRET_PROD
      : process.env.WOMPI_EVENTS_SECRET_TEST;
    if (!eventsSecret)
      throw new UnauthorizedException(
        'Events secret not configured for current env',
      );

    // Concatenar en el ORDEN exacto que llega en properties
    const concatProps = properties
      .map((path: string) => {
        const v = get(body.data, path);
        // Si alguno no existe, Wompi espera cadena vacía en esa posición
        return v == null ? '' : String(v);
      })
      .join('');

    const local = createHash('sha256')
      .update(`${concatProps}${timestamp}${eventsSecret}`)
      .digest('hex')
      .toUpperCase();

    const remote = String(checksum).toUpperCase();

    if (local !== remote || local !== headerChecksum) {
      throw new UnauthorizedException('Invalid checksum');
    }
    return true;
  }
}
