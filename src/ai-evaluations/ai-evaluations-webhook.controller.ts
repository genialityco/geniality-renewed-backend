import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { AiEvaluationEngineService } from './ai-evaluation-engine.service';

interface InboundMessage {
  from?: string;
  text?: string;
  wamid?: string;
  timestamp?: string;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Recibe los mensajes de texto entrantes que reenvía el gateway de WhatsApp
 * (wa-multisession-backend). Responde de inmediato y procesa en segundo
 * plano: el gateway contesta a Meta dentro del mismo request y Meta reintenta
 * si tarda.
 */
@Controller('ai-evaluations/whatsapp')
export class AiEvaluationsWebhookController {
  constructor(private readonly engine: AiEvaluationEngineService) {}

  /** POST /ai-evaluations/whatsapp/inbound  [x-webhook-secret] */
  @Post('inbound')
  @HttpCode(202)
  inbound(
    @Headers('x-webhook-secret') secret: string | undefined,
    @Body() body: InboundMessage,
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

    const phone = String(body?.from || '').replace(/\D/g, '');
    const text = String(body?.text || '').trim();
    if (phone && text) {
      this.engine.enqueueInbound(phone, text, body.wamid);
    }
    return { status: 'accepted' };
  }
}
