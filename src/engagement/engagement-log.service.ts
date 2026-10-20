import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SendOutcome } from 'src/reminders/whatsapp-gateway.client';
import {
  EngagementKind,
  EngagementMessage,
  EngagementStatus,
} from './schemas/engagement-message.schema';
import { isInHoldout } from './engagement-policy';

const DAY_MS = 24 * 60 * 60 * 1000;
// Un mensaje entrante cuenta como respuesta al último envío de este plazo
export const REPLY_WINDOW_HOURS = 72;

export function phoneTail(phone: string | null | undefined): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits ? digits.slice(-10) : null;
}
// Estados que cuentan como "le escribimos" para el tope semanal
const COUNTED_STATUSES: EngagementStatus[] = [
  'pending',
  'sent',
  'fallback_email',
];

export interface EngagementEntry {
  dedupeKey: string;
  kind: EngagementKind;
  userId: string;
  organizationId: string;
  eventId?: string | null;
  template?: string | null;
  phone?: string | null;
}

export type DeliveryResult =
  | 'sent'
  | 'fallback_email'
  | 'duplicate'
  | 'holdout'
  | 'capped';

/**
 * Punto único por el que pasan los mensajes que inicia la plataforma:
 * deduplica por clave, aplica el grupo de control y el tope semanal por
 * estudiante, y deja registro del resultado.
 *
 * Configuración:
 * - ENGAGEMENT_WEEKLY_CAP (default 3): máximo de mensajes por estudiante en
 *   7 días, sumando todos los tipos (incluidos los repasos, que se registran
 *   pero no se bloquean).
 * - ENGAGEMENT_HOLDOUT_PERCENT (default 0): % de estudiantes que no recibe
 *   recordatorios y sirve de grupo de control.
 * - ENGAGEMENT_CLICK_REF (default false): agrega ?ref=<id del envío> al
 *   enlace del botón para medir clics. Activarlo solo después de comprobar
 *   con "Probar plantillas" que el enlace abre bien.
 */
@Injectable()
export class EngagementLogService {
  private readonly logger = new Logger(EngagementLogService.name);
  private readonly weeklyCap: number;
  private readonly holdoutPercent: number;
  private readonly clickRefEnabled: boolean;

  constructor(
    @InjectModel(EngagementMessage.name)
    private readonly messageModel: Model<EngagementMessage>,
    configService: ConfigService,
  ) {
    const cap = Number(configService.get('ENGAGEMENT_WEEKLY_CAP'));
    this.weeklyCap = Number.isFinite(cap) && cap > 0 ? cap : 3;
    const holdout = Number(configService.get('ENGAGEMENT_HOLDOUT_PERCENT'));
    this.holdoutPercent = Number.isFinite(holdout) ? holdout : 0;
    this.clickRefEnabled =
      configService.get('ENGAGEMENT_CLICK_REF') === 'true';
  }

  /**
   * Sufijo para el enlace del botón que identifica el envío ('' si el
   * seguimiento de clics está apagado). `path` puede traer ya query string.
   */
  withClickRef(path: string, ref: string): string {
    if (!this.clickRefEnabled) return path;
    return `${path}${path.includes('?') ? '&' : '?'}ref=${ref}`;
  }

  /**
   * Envía un mensaje solo si corresponde y registra el resultado. `send`
   * recibe el id del registro (para el ?ref= del enlace) y hace el envío
   * real; si lanza, queda como 'failed' y el error se propaga.
   */
  async deliver(
    entry: EngagementEntry,
    send: (ref: string) => Promise<SendOutcome>,
  ): Promise<DeliveryResult> {
    const claim = await this.claim(entry);
    if (claim.decision !== 'send') return claim.decision;

    try {
      const outcome = await send(String(claim.id));
      await this.finish(claim.id, outcome.result, undefined, outcome.messageId, {
        click_tracked: this.clickRefEnabled && outcome.result === 'sent',
      });
      return outcome.result;
    } catch (error) {
      await this.finish(claim.id, 'failed', (error as Error)?.message);
      throw error;
    }
  }

  /**
   * Registra un envío que ya ocurrió fuera de `deliver` (p. ej. la invitación
   * a un simulacro, que tiene su propia lógica de reintentos y ventana).
   */
  async record(
    entry: Omit<EngagementEntry, 'dedupeKey'> & { dedupeKey?: string | null },
    status: EngagementStatus,
    error?: string,
    wamid?: string | null,
  ): Promise<void> {
    try {
      await this.messageModel.create({
        ...this.toDoc(entry),
        status,
        error: error?.slice(0, 500) || null,
        wamid: wamid || null,
        meta_status: wamid ? 'sent' : null,
      });
    } catch (err) {
      this.logger.warn(
        `No se pudo registrar el envío ${entry.kind} de ${entry.userId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Asocia un mensaje entrante al último envío por WhatsApp a ese número
   * dentro de REPLY_WINDOW_HOURS. Solo se guarda la primera respuesta; las
   * siguientes no se asignan a envíos más antiguos. Devuelve el tipo del
   * envío respondido, o null si el mensaje no responde a ninguno.
   */
  async markReply(phone: string, text: string): Promise<string | null> {
    const last = await this.lastDeliveredTo(phone);
    if (!last) return null;
    if (!last.replied_at) {
      await this.messageModel
        .updateOne(
          { _id: last._id, replied_at: null },
          {
            $set: {
              replied_at: new Date(),
              reply_text: String(text ?? '').slice(0, 280),
            },
          },
        )
        .exec();
    }
    return last.kind;
  }

  /**
   * Primer clic en el botón del mensaje. `ref` es el id del envío que viaja
   * en el enlace; cualquier otro valor (p. ej. "test") se ignora.
   */
  async markClick(ref: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(ref) || String(new Types.ObjectId(ref)) !== ref) {
      return false;
    }
    const res = await this.messageModel
      .updateOne(
        { _id: new Types.ObjectId(ref), clicked_at: null },
        { $set: { clicked_at: new Date() } },
      )
      .exec();
    return res.modifiedCount > 0;
  }

  /**
   * Estado de entrega que reporta Meta (vía el gateway). Solo avanza
   * (sent → delivered → read); 'failed' se registra aparte con su error.
   * Devuelve false si el wamid no corresponde a un envío registrado.
   */
  async markMetaStatus(params: {
    wamid: string;
    status: string;
    at?: Date;
    error?: string | null;
  }): Promise<boolean> {
    const { wamid, status } = params;
    const at = params.at && !isNaN(params.at.getTime()) ? params.at : new Date();
    let update: Record<string, any>;
    let filter: Record<string, any> = { wamid };
    if (status === 'delivered') {
      filter = { wamid, meta_status: { $in: [null, 'sent'] } };
      update = { meta_status: 'delivered', delivered_at: at };
    } else if (status === 'read') {
      filter = { wamid, meta_status: { $ne: 'read' } };
      update = { meta_status: 'read', read_at: at };
    } else if (status === 'failed') {
      update = {
        meta_status: 'failed',
        meta_error: String(params.error || 'failed').slice(0, 500),
      };
    } else {
      return false;
    }

    const res = await this.messageModel.updateOne(filter, { $set: update }).exec();
    // Leído implica entregado aunque Meta no haya enviado 'delivered'
    if (status === 'read' && res.matchedCount > 0) {
      await this.messageModel
        .updateOne({ wamid, delivered_at: null }, { $set: { delivered_at: at } })
        .exec();
    }
    if (res.matchedCount > 0) return true;
    return Boolean(await this.messageModel.exists({ wamid }).exec());
  }

  /** Marca que el estudiante se dio de baja en respuesta al último envío. */
  async markOptOut(phone: string): Promise<void> {
    const last = await this.lastDeliveredTo(phone);
    if (!last || last.opted_out_at) return;
    await this.messageModel
      .updateOne({ _id: last._id }, { $set: { opted_out_at: new Date() } })
      .exec();
  }

  private async lastDeliveredTo(phone: string) {
    const tail = phoneTail(phone);
    if (!tail) return null;
    return this.messageModel
      .findOne({
        phone_tail: tail,
        // Por email de respaldo no hubo WhatsApp que responder
        status: 'sent',
        at: { $gte: new Date(Date.now() - REPLY_WINDOW_HOURS * 3600000) },
      })
      .sort({ at: -1 })
      .select('kind replied_at opted_out_at')
      .lean()
      .exec();
  }

  private async claim(
    entry: EngagementEntry,
  ): Promise<
    | { decision: 'send'; id: unknown }
    | { decision: 'duplicate' | 'holdout' | 'capped' }
  > {
    const existing = await this.messageModel
      .findOne({ dedupe_key: entry.dedupeKey })
      .select('status')
      .lean()
      .exec();
    // Solo un fallo del gateway permite reintentar la misma clave
    if (existing && existing.status !== 'failed') {
      return { decision: 'duplicate' };
    }

    let status: EngagementStatus = 'pending';
    if (isInHoldout(entry.userId, this.holdoutPercent)) {
      status = 'holdout';
    } else if ((await this.countRecent(entry.userId)) >= this.weeklyCap) {
      status = 'capped';
    }

    const doc = { ...this.toDoc(entry), status, error: null };
    let id: unknown;
    try {
      if (existing) {
        const res = await this.messageModel
          .findOneAndUpdate(
            { _id: existing._id, status: 'failed' },
            { $set: doc },
            { new: true },
          )
          .exec();
        // Otro proceso tomó el reintento primero
        if (!res) return { decision: 'duplicate' };
        id = res._id;
      } else {
        id = (await this.messageModel.create(doc))._id;
      }
    } catch (error) {
      if ((error as any)?.code === 11000) return { decision: 'duplicate' };
      throw error;
    }

    if (status === 'pending') return { decision: 'send', id };
    return { decision: status as 'holdout' | 'capped' };
  }

  private async finish(
    id: unknown,
    status: EngagementStatus,
    error?: string,
    wamid?: string | null,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.messageModel
      .updateOne(
        { _id: id },
        {
          $set: {
            ...extra,
            status,
            error: error?.slice(0, 500) || null,
            at: new Date(),
            ...(wamid ? { wamid, meta_status: 'sent' } : {}),
          },
        },
      )
      .exec()
      .catch((err) =>
        this.logger.warn(
          `No se pudo cerrar el registro ${String(id)}: ${err.message}`,
        ),
      );
  }

  private async countRecent(userId: string): Promise<number> {
    return this.messageModel
      .countDocuments({
        user_id: String(userId),
        status: { $in: COUNTED_STATUSES },
        at: { $gte: new Date(Date.now() - 7 * DAY_MS) },
      })
      .exec();
  }

  private toDoc(
    entry: Omit<EngagementEntry, 'dedupeKey'> & { dedupeKey?: string | null },
  ) {
    return {
      dedupe_key: entry.dedupeKey || null,
      kind: entry.kind,
      user_id: String(entry.userId),
      organization_id: String(entry.organizationId),
      event_id: entry.eventId ? String(entry.eventId) : null,
      channel: 'whatsapp',
      template: entry.template || null,
      phone: entry.phone || null,
      phone_tail: phoneTail(entry.phone),
      at: new Date(),
    };
  }
}
