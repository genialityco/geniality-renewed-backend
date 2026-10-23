import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  OutboundMessage,
  WhatsappGatewayClient,
} from 'src/reminders/whatsapp-gateway.client';
import { WhatsappContact } from './schemas/whatsapp-contact.schema';
import { WhatsappInboundMessage } from './schemas/whatsapp-inbound-message.schema';
import {
  AiEvaluationEngineService,
  CODE_PATTERN,
} from './ai-evaluation-engine.service';
import {
  OPT_OUT_WORDS,
  PracticeEngineService,
} from './practice-engine.service';
import { normalizeText } from './practice-format';
import { WhatsappOptOutService } from 'src/engagement/whatsapp-opt-out.service';
import { EngagementLogService } from 'src/engagement/engagement-log.service';

const DEDUPE_TTL_MS = 24 * 3600 * 1000;
// Un mensaje que Meta entrega con más antigüedad es un reintento tardío del
// webhook: responderlo ahora sería contestar algo que la persona ya no espera
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;
const OPT_OUT_REPLY =
  'Listo, no te enviaremos más prácticas ni recordatorios por WhatsApp. Si cambias de opinión, responde VOLVER o actívalo desde tu perfil en la plataforma. 👋';
const OPT_IN_WORDS = new Set(['volver']);
const OPT_IN_REPLY =
  '¡Bienvenido de vuelta! 🙌 Volverás a recibir nuestros mensajes por WhatsApp. Si quieres dejar de recibirlos, responde BAJA.';

/**
 * Conversación de otro módulo (p. ej. Gen.ON) que se atiende antes que los
 * simulacros: `matches` decide si el mensaje le corresponde (un botón suyo o
 * una conversación suya pendiente para ese teléfono).
 */
export interface InboundHandler {
  name: string;
  matches(phone: string, text: string, replyId?: string): Promise<boolean>;
  handle(
    phone: string,
    text: string,
    replyId?: string,
  ): Promise<OutboundMessage[] | null>;
}

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
 * 2. BAJA / VOLVER (sin evaluación EV- en curso, donde pueden ser una
 *    respuesta) → baja o reactivación de todas las membresías del número;
 *    con BAJA y simulacro activo, además lo cancela el motor del simulacro.
 * 3. Manejadores registrados (Gen.ON: sus botones "gn:..." y conversaciones).
 * 4. Botón de un simulacro (replyId "pq:...") o simulacro en curso → simulacro.
 * 5. Evaluación EV- en curso → evaluación.
 * 6. Simulacro invitado (esperando "Empezar") → simulacro.
 * 7. Respaldo (asistente por WhatsApp): lo que ningún motor atendió.
 * 8. Si no, se ignora.
 *
 * La cola y la deduplicación viven en memoria: asume una sola instancia.
 */
@Injectable()
export class WhatsappInboundService {
  private readonly logger = new Logger(WhatsappInboundService.name);
  private readonly phoneQueues = new Map<string, Promise<unknown>>();
  private readonly seenMessages = new Map<string, number>();
  private readonly handlers: InboundHandler[] = [];
  private readonly fallbacks: InboundHandler[] = [];

  /** Lo llaman otros módulos al iniciar (así ai-evaluations no depende de ellos). */
  registerHandler(handler: InboundHandler): void {
    if (!this.handlers.some((h) => h.name === handler.name)) {
      this.handlers.push(handler);
    }
  }

  /**
   * Respaldo: recibe los mensajes que ningún motor atendió (p. ej. el
   * asistente). Nunca le quita un mensaje a un reto, simulacro o evaluación.
   */
  registerFallback(handler: InboundHandler): void {
    if (!this.fallbacks.some((h) => h.name === handler.name)) {
      this.fallbacks.push(handler);
    }
  }

  constructor(
    @InjectModel(WhatsappContact.name)
    private readonly contactModel: Model<WhatsappContact>,
    private readonly aiEvaluation: AiEvaluationEngineService,
    private readonly practice: PracticeEngineService,
    private readonly whatsapp: WhatsappGatewayClient,
    private readonly optOut: WhatsappOptOutService,
    private readonly engagementLog: EngagementLogService,
    @InjectModel(WhatsappInboundMessage.name)
    private readonly inboundMessageModel?: Model<WhatsappInboundMessage>,
  ) {}

  /**
   * No bloquea: encola el mensaje del teléfono y responde cuando termina.
   * Un mismo mensaje (wamid) se responde una sola vez, aunque Meta lo
   * reintente o el backend se haya reiniciado; los reintentos tardíos
   * (`timestamp` de Meta, en segundos) se ignoran.
   */
  enqueue(
    phone: string,
    text: string,
    replyId?: string,
    wamid?: string,
    timestamp?: string | number,
  ): void {
    const sentAt = Number(timestamp) * 1000;
    if (Number.isFinite(sentAt) && sentAt > 0 && Date.now() - sentAt > MAX_MESSAGE_AGE_MS) {
      this.logger.warn(
        `Mensaje de ${phone} ignorado: llegó ${Math.round((Date.now() - sentAt) / 60000)} min tarde (reintento de Meta)`,
      );
      return;
    }
    if (wamid && this.isDuplicate(wamid)) return;

    const previous = this.phoneQueues.get(phone) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (wamid && !(await this.claim(wamid, phone))) return;
        return this.process(phone, text, replyId);
      });
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

  /**
   * Registra el mensaje como procesado. false si ya lo estaba (lo procesó
   * otra ejecución o una instancia anterior del backend). Si la base falla,
   * se procesa: es preferible responder dos veces que no responder.
   */
  private async claim(wamid: string, phone: string): Promise<boolean> {
    if (!this.inboundMessageModel) return true;
    try {
      await this.inboundMessageModel.create({ wamid, phone, received_at: new Date() });
      return true;
    } catch (error) {
      if ((error as any)?.code === 11000) {
        this.logger.warn(`Mensaje ${wamid} de ${phone} ya procesado: se ignora el reintento`);
        return false;
      }
      this.logger.warn(`No se pudo registrar el mensaje ${wamid}: ${(error as Error).message}`);
      return true;
    }
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

    // Respuesta a un mensaje de la plataforma (recordatorio, reporte...):
    // queda en la bitácora de envíos aunque ningún motor la atienda
    const repliedTo = await this.engagementLog
      .markReply(phone, text)
      .catch((e) => {
        this.logger.warn(
          `No se pudo registrar la respuesta de ${phone}: ${e.message}`,
        );
        return null;
      });

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
    if (!replies?.length) {
      if (repliedTo) {
        this.logger.log(`Respuesta a ${repliedTo} de ${phone}: ${summary}`);
      }
      return;
    }
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

    // 2. Baja
    if (
      OPT_OUT_WORDS.has(normalizeText(text)) &&
      !(await this.aiEvaluation.hasActiveSession(phone))
    ) {
      const memberships = await this.optOut.optOutByPhone(phone);
      await this.engagementLog
        .markOptOut(phone)
        .catch((e) =>
          this.logger.warn(`No se pudo marcar la baja de ${phone}: ${e.message}`),
        );
      if (await this.practice.findActiveSession(phone)) {
        return this.practice.handleMessage(phone, text, replyId);
      }
      // Número compartido: si no es de un estudiante, no se responde
      return memberships ? [OPT_OUT_REPLY] : null;
    }

    // 2b. Reactivación (revierte la baja)
    if (
      OPT_IN_WORDS.has(normalizeText(text)) &&
      !(await this.aiEvaluation.hasActiveSession(phone))
    ) {
      const memberships = await this.optOut.optInByPhone(phone);
      return memberships ? [OPT_IN_REPLY] : null;
    }

    // 3. Conversaciones de otros módulos (Gen.ON)
    for (const handler of this.handlers) {
      if (await handler.matches(phone, text, replyId)) {
        return handler.handle(phone, text, replyId);
      }
    }

    const practiceSession = await this.practice.findActiveSession(phone);

    // 4. Botón del simulacro o simulacro en curso
    if (
      practiceSession &&
      (this.practice.isOwnReply(replyId) ||
        practiceSession.status !== 'invited')
    ) {
      return this.practice.handleMessage(phone, text, replyId);
    }

    // 5. Evaluación EV- en curso
    if (await this.aiEvaluation.hasActiveSession(phone)) {
      return this.wrap(await this.aiEvaluation.handleMessage(phone, text));
    }

    // 6. Invitación a simulacro pendiente (p. ej. botón "Empezar" de la plantilla)
    if (practiceSession) {
      return this.practice.handleMessage(phone, text, replyId);
    }

    // 7. Respaldo (asistente)
    for (const fallback of this.fallbacks) {
      if (await fallback.matches(phone, text, replyId)) {
        return fallback.handle(phone, text, replyId);
      }
    }
    return null;
  }

  private wrap(reply: string | null): OutboundMessage[] | null {
    return reply ? [reply] : null;
  }
}
