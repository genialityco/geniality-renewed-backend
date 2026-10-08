import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  OutboundMessage,
  WhatsappGatewayClient,
} from 'src/reminders/whatsapp-gateway.client';
import { WhatsappContact } from './schemas/whatsapp-contact.schema';
import {
  AiEvaluationEngineService,
  CODE_PATTERN,
} from './ai-evaluation-engine.service';
import { PracticeEngineService } from './practice-engine.service';

const DEDUPE_TTL_MS = 24 * 3600 * 1000;

function sendErrorDetail(error: unknown): string {
  const data = (error as any)?.response?.data;
  return (
    [data?.error, data?.code, data?.details].filter(Boolean).join(' · ') ||
    (error as Error).message
  );
}

/**
 * Versión en texto de un mensaje interactivo, por si Meta lo rechaza. Los
 * cuerpos del motor ya enumeran las opciones de las listas; de los botones
 * se agregan sus títulos.
 */
function asPlainText(message: Exclude<OutboundMessage, string>): string {
  const parts: string[] = [];
  if (message.header) parts.push(`*${message.header}*`);
  parts.push(message.body);
  if (message.buttons?.length) {
    parts.push(
      `Responde: ${message.buttons.map((b) => `*${b.title}*`).join(' / ')}`,
    );
  }
  if (message.footer) parts.push(`_${message.footer}_`);
  return parts.join('\n\n');
}

/**
 * Entrada única de los mensajes de WhatsApp que reenvía el gateway
 * (wa-multisession-backend). Deduplica por wamid, procesa en serie los
 * mensajes de cada teléfono y los enruta:
 *
 * 1. Código EV-XXXXXX → evaluación por WhatsApp (cancela simulacros activos).
 * 2. Botón de un simulacro (replyId "pq:...") o simulacro en curso → simulacro.
 * 3. Evaluación EV- en curso → evaluación.
 * 4. Simulacro invitado (esperando "Empezar") → simulacro.
 * 5. Si no, se ignora.
 *
 * La cola y la deduplicación viven en memoria: asume una sola instancia.
 */
@Injectable()
export class WhatsappInboundService {
  private readonly logger = new Logger(WhatsappInboundService.name);
  private readonly phoneQueues = new Map<string, Promise<unknown>>();
  private readonly seenMessages = new Map<string, number>();

  constructor(
    @InjectModel(WhatsappContact.name)
    private readonly contactModel: Model<WhatsappContact>,
    private readonly aiEvaluation: AiEvaluationEngineService,
    private readonly practice: PracticeEngineService,
    private readonly whatsapp: WhatsappGatewayClient,
  ) {}

  /** No bloquea: encola el mensaje del teléfono y responde cuando termina. */
  enqueue(phone: string, text: string, replyId?: string, wamid?: string): void {
    if (wamid && this.isDuplicate(wamid)) return;

    const previous = this.phoneQueues.get(phone) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.process(phone, text, replyId));
    this.phoneQueues.set(phone, next);
    void next.finally(() => {
      if (this.phoneQueues.get(phone) === next) this.phoneQueues.delete(phone);
    });
  }

  /** ¿Escribió el teléfono en las últimas ~24 h? (ventana de mensajes libres) */
  async isWindowOpen(phone: string): Promise<boolean> {
    const contact = await this.contactModel.findOne({ phone }).lean().exec();
    const last = contact?.last_inbound_at?.getTime() || 0;
    // Margen de 1 h para no enviar justo cuando la ventana se cierra
    return Date.now() - last < 23 * 3600 * 1000;
  }

  private isDuplicate(wamid: string): boolean {
    const now = Date.now();
    for (const [id, at] of this.seenMessages) {
      if (now - at > DEDUPE_TTL_MS) this.seenMessages.delete(id);
      else break; // Map mantiene orden de inserción
    }
    if (this.seenMessages.has(wamid)) return true;
    this.seenMessages.set(wamid, now);
    return false;
  }

  private async process(
    phone: string,
    text: string,
    replyId?: string,
  ): Promise<void> {
    await this.contactModel
      .updateOne(
        { phone },
        { $set: { last_inbound_at: new Date() } },
        { upsert: true },
      )
      .exec()
      .catch((e) =>
        this.logger.warn(
          `No se pudo registrar el contacto ${phone}: ${e.message}`,
        ),
      );

    // El número también se usa para otras cosas: solo se registran en el log
    // los mensajes que le corresponden a GenCampus
    const summary = `"${text.slice(0, 60)}"${replyId ? ` (replyId ${replyId})` : ''}`;
    let replies: OutboundMessage[] | null;
    try {
      replies = await this.route(phone, text, replyId);
    } catch (error) {
      this.logger.error(
        `Error procesando mensaje de ${phone} ${summary}: ${(error as Error).message}`,
      );
      replies = [
        'Tuve un problema procesando tu mensaje. Por favor envíalo de nuevo en un momento.',
      ];
    }
    if (!replies?.length) return;
    this.logger.log(`Mensaje entrante de ${phone}: ${summary}`);

    for (const message of replies) {
      try {
        await this.whatsapp.sendOutbound(phone, message);
        continue;
      } catch (error) {
        const detail = sendErrorDetail(error);
        if (typeof message === 'string') {
          this.logger.error(
            `No se pudo enviar la respuesta a ${phone}: ${detail}`,
          );
          return;
        }
        // Meta rechazó el interactivo (botones/lista): se manda como texto,
        // que el motor también entiende (número, letra, "empezar"...)
        this.logger.warn(
          `Interactivo rechazado para ${phone} (${detail}); se envía como texto`,
        );
      }
      try {
        await this.whatsapp.sendText(phone, asPlainText(message));
      } catch (error) {
        this.logger.error(
          `No se pudo enviar la respuesta a ${phone}: ${sendErrorDetail(error)}`,
        );
        return;
      }
    }
  }

  private async route(
    phone: string,
    text: string,
    replyId?: string,
  ): Promise<OutboundMessage[] | null> {
    // 1. Código de evaluación
    if (CODE_PATTERN.test(text)) {
      await this.practice.cancelActive(phone);
      return this.wrap(await this.aiEvaluation.handleMessage(phone, text));
    }

    const practiceSession = await this.practice.findActiveSession(phone);

    // 2. Botón del simulacro o simulacro en curso
    if (
      practiceSession &&
      (this.practice.isOwnReply(replyId) ||
        practiceSession.status !== 'invited')
    ) {
      return this.practice.handleMessage(phone, text, replyId);
    }

    // 3. Evaluación EV- en curso
    if (await this.aiEvaluation.hasActiveSession(phone)) {
      return this.wrap(await this.aiEvaluation.handleMessage(phone, text));
    }

    // 4. Invitación a simulacro pendiente (p. ej. botón "Empezar" de la plantilla)
    if (practiceSession) {
      return this.practice.handleMessage(phone, text, replyId);
    }
    return null;
  }

  private wrap(reply: string | null): OutboundMessage[] | null {
    return reply ? [reply] : null;
  }
}
