import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { EngagementLogService } from './engagement-log.service';

interface MetaStatusEvent {
  wamid?: string;
  status?: string;
  timestamp?: string | number;
  recipientId?: string;
  errors?: { code?: number; title?: string; message?: string }[];
}

// Meta puede reportar el estado antes de que se guarde el wamid del envío
const RETRY_DELAY_MS = 5000;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Entradas externas de la bitácora de envíos: estados de entrega de Meta
 * (los reenvía el gateway) y clics en el botón de los mensajes (los reporta
 * el frontend al abrir un enlace con ?ref=).
 */
@Controller('engagement')
export class EngagementWebhookController {
  private readonly logger = new Logger(EngagementWebhookController.name);

  constructor(private readonly engagementLog: EngagementLogService) {}

  /**
   * POST /engagement/whatsapp/status  [x-webhook-secret]
   * Body: { wamid, status: sent|delivered|read|failed, timestamp, errors? }
   * Mismo secreto que la entrada de mensajes (AI_EVALUATION_WEBHOOK_SECRET).
   */
  @Post('whatsapp/status')
  @HttpCode(202)
  status(
    @Headers('x-webhook-secret') secret: string | undefined,
    @Body() body: MetaStatusEvent,
  ) {
    const expected = process.env.AI_EVALUATION_WEBHOOK_SECRET;
    if (!expected) {
      throw new ServiceUnavailableException(
        'AI_EVALUATION_WEBHOOK_SECRET no configurado',
      );
    }
    if (!secret || !safeEqual(secret, expected)) {
      throw new UnauthorizedException();
    }

    const wamid = String(body?.wamid || '');
    const status = String(body?.status || '');
    if (wamid && status) {
      // No bloquea al gateway: responde de inmediato y procesa aparte
      void this.applyStatus(wamid, status, body);
    }
    return { status: 'accepted' };
  }

  /** POST /engagement/clicks  { ref }  (público: lo llama el navegador) */
  @Post('clicks')
  @HttpCode(204)
  async click(@Body('ref') ref?: string) {
    if (typeof ref === 'string' && ref.length <= 64) {
      await this.engagementLog.markClick(ref).catch(() => false);
    }
  }

  private async applyStatus(
    wamid: string,
    status: string,
    body: MetaStatusEvent,
  ): Promise<void> {
    const seconds = Number(body.timestamp);
    const params = {
      wamid,
      status,
      at: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : undefined,
      error: body.errors?.length
        ? body.errors
            .map((e) => [e.code, e.title || e.message].filter(Boolean).join(' '))
            .join('; ')
        : null,
    };
    try {
      if (await this.engagementLog.markMetaStatus(params)) return;
      // Puede llegar antes de que se guarde el wamid del envío: un reintento.
      // Si tampoco aparece, el mensaje no es de la bitácora (otro servicio
      // que comparte el número) y se ignora.
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      await this.engagementLog.markMetaStatus(params);
    } catch (error) {
      this.logger.warn(
        `No se pudo registrar el estado ${status} de ${wamid}: ${(error as Error).message}`,
      );
    }
  }
}
