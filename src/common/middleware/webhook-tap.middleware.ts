import { Injectable, NestMiddleware } from '@nestjs/common';

// Depurador para webhook de wompi, se habilita en module de payment-requests
@Injectable()
export class WebhookTapMiddleware implements NestMiddleware {
  use(req: any, _res: any, next: () => void) {
    if (req.originalUrl?.includes('/payment-requests/webhook')) {
      console.log(
        '[WOMPI TAP] headers.x-event-checksum:',
        req.headers['x-event-checksum'],
      );
      console.log('[WOMPI TAP] body keys:', Object.keys(req.body || {}));
      console.log('[WOMPI TAP] body.signature:', req.body?.signature);
      console.log(
        '[WOMPI TAP] body.data?.transaction keys:',
        Object.keys(req.body?.data?.transaction || {}),
      );
    }
    next();
  }
}
