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
import { WhatsappInboundService } from './whatsapp-inbound.service';

interface InboundMessage {
  from?: string;
  text?: string;
  // id del botón/opción interactiva o payload del quick reply de plantilla
  replyId?: string;
  wamid?: string;
  timestamp?: string;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Recibe los mensajes entrantes (texto y respuestas a botones) que reenvía el
 * gateway de WhatsApp (wa-multisession-backend) para las evaluaciones EV- y
 * los simulacros de práctica. Responde de inmediato y procesa en segundo
 * plano: el gateway contesta a Meta dentro del mismo request y Meta reintenta
 * si tarda.
 */
@Controller('ai-evaluations/whatsapp')
export class AiEvaluationsWebhookController {
  constructor(private readonly inboundService: WhatsappInboundService) {}

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
      const replyId = body.replyId ? String(body.replyId) : undefined;
      this.inboundService.enqueue(phone, text, replyId, body.wamid);
    }
    return { status: 'accepted' };
  }
}
