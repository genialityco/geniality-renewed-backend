/* eslint-disable prefer-const */
// src/wompi/wompi-webhook.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PaymentLogsService } from 'src/payment-logs/payment-logs.service';

function get(obj: any, path: string) {
  return path
    .split('.')
    .reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

@Injectable()
export class WompiWebhookGuard implements CanActivate {
  private readonly logger = new Logger(WompiWebhookGuard.name);

  constructor(private readonly paymentLogs: PaymentLogsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();

    const headerChecksum = (
      req.headers['x-event-checksum'] as string | undefined
    )?.toUpperCase();

    if (!headerChecksum) {
      await this.paymentLogs.write({
        level: 'warn',
        message: 'webhook-guard: falta x-event-checksum',
        source: 'webhook',
        meta: { hasHeader: false },
      });
      throw new UnauthorizedException('Missing x-event-checksum header');
    }

    const body = req.body;
    if (!body?.signature || !body?.data) {
      await this.paymentLogs.write({
        level: 'warn',
        message: 'webhook-guard: body inválido (signature/data)',
        source: 'webhook',
        meta: {
          hasSignature: Boolean(body?.signature),
          hasData: Boolean(body?.data),
        },
      });
      throw new BadRequestException('Invalid body: signature/data missing');
    }

    const sig = body.signature ?? {};
    let { properties, checksum } = sig as {
      properties?: string[];
      checksum?: string;
      timestamp?: string | number;
    };

    // timestamp preferente en signature; si no, body.timestamp/body.sent_at
    let tsRaw: string | number | undefined =
      (sig as any).timestamp ?? body.timestamp ?? body.sent_at;

    if (
      !Array.isArray(properties) ||
      !properties.every((p) => typeof p === 'string')
    ) {
      await this.paymentLogs.write({
        level: 'warn',
        message: 'webhook-guard: signature.properties inválido',
        source: 'webhook',
        meta: { propertiesType: typeof properties },
      });
      throw new BadRequestException('Invalid signature.properties');
    }

    if (typeof tsRaw !== 'string' && typeof tsRaw !== 'number') {
      await this.paymentLogs.write({
        level: 'warn',
        message: 'webhook-guard: signature.timestamp inválido',
        source: 'webhook',
        meta: { hasTimestamp: false },
      });
      throw new BadRequestException('Invalid signature.timestamp');
    }
    const timestamp = String(tsRaw);

    if (typeof checksum !== 'string') {
      await this.paymentLogs.write({
        level: 'warn',
        message: 'webhook-guard: signature.checksum inválido',
        source: 'webhook',
        meta: { hasChecksum: false },
      });
      throw new BadRequestException('Invalid signature.checksum');
    }

    // (Opcional) anti-replay ±5 min si timestamp es numérico (epoch ms)
    const tsNum = Number(timestamp);
    if (!Number.isNaN(tsNum) && Math.abs(Date.now() - tsNum) > 5 * 60 * 1000) {
      this.logger.warn(`[WOMPI GUARD] stale timestamp: ${tsNum}`);
      await this.paymentLogs.write({
        level: 'warn',
        message: 'webhook-guard: timestamp fuera de ventana',
        source: 'webhook',
        meta: { tsNum },
      });
      // decisión: advertimos, pero no rechazamos
    }

    // secreto por entorno
    const isProd = process.env.WOMPI_ENV === 'production';
    const eventsSecret = isProd
      ? process.env.WOMPI_EVENTS_SECRET_PROD
      : process.env.WOMPI_EVENTS_SECRET_TEST;

    if (!eventsSecret) {
      await this.paymentLogs.write({
        level: 'error',
        message: 'webhook-guard: events secret no configurado',
        source: 'webhook',
        meta: { env: isProd ? 'prod' : 'test' },
      });
      throw new UnauthorizedException(
        'Events secret not configured for current env',
      );
    }

    // concatenar EXACTO según properties desde body.data
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
      // Loggear con info útil pero sin exponer secrets
      await this.paymentLogs.write({
        level: 'warn',
        message: 'webhook-guard: checksum mismatch',
        source: 'webhook',
        // intenta extraer referencia/tx si vienen en body.data
        reference: get(body?.data, 'transaction.reference'),
        transactionId: get(body?.data, 'transaction.id'),
        meta: {
          hasHeader: true,
          propsCount: properties.length,
          tsProvided: Boolean(timestamp),
          // NO guardamos ni secret ni los hashes completos
        },
      });
      throw new UnauthorizedException('Invalid checksum');
    }

    // Aceptado: deja rastro mínimo (útil para conteo y auditoría)
    await this.paymentLogs.write({
      level: 'info',
      message: 'webhook-guard: verificación OK',
      source: 'webhook',
      reference: get(body?.data, 'transaction.reference'),
      transactionId: get(body?.data, 'transaction.id'),
      meta: { propsCount: properties.length, env: isProd ? 'prod' : 'test' },
    });

    return true;
  }
}
