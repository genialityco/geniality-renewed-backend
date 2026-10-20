import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type EngagementKind =
  | 'inactivity_reminder'
  | 'weekly_report'
  | 'course_ranking'
  | 'practice_review'
  | 'practice_invite';

/**
 * - pending: reservado, enviándose (si queda así, el proceso cayó a mitad
 *   del envío; no se reintenta para no duplicar).
 * - sent / fallback_email: entregado al gateway (por WhatsApp o por email).
 * - failed: el gateway lo rechazó; la misma clave se puede reintentar.
 * - holdout: no se envió porque el estudiante está en el grupo de control.
 * - capped: no se envió por el tope semanal de mensajes del estudiante.
 */
export type EngagementStatus =
  | 'pending'
  | 'sent'
  | 'fallback_email'
  | 'failed'
  | 'holdout'
  | 'capped';

/**
 * Bitácora de los mensajes que inicia la plataforma (no las respuestas dentro
 * de una conversación). Evita duplicados entre el cron y los endpoints
 * manuales, permite el tope de frecuencia por estudiante y, cruzada con
 * progress_events, medir el efecto de cada tipo de mensaje contra el grupo
 * de control.
 *
 * Los ids se guardan como string, igual que en progress_events.
 */
@Schema({
  collection: 'engagement_messages',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
})
export class EngagementMessage extends Document {
  // Identifica el envío lógico (p. ej. "weekly_report:<user>:<org>:<semana>")
  @Prop({ type: String, default: null }) dedupe_key: string | null;
  @Prop({ required: true }) kind: EngagementKind;
  @Prop({ required: true }) user_id: string;
  @Prop({ required: true }) organization_id: string;
  @Prop({ type: String, default: null }) event_id: string | null;
  @Prop({ default: 'whatsapp' }) channel: string;
  @Prop({ type: String, default: null }) template: string | null;
  @Prop({ type: String, default: null }) phone: string | null;
  // Últimos 10 dígitos: así se asocian las respuestas aunque Meta reporte
  // el número con otro prefijo de país
  @Prop({ type: String, default: null }) phone_tail: string | null;
  @Prop({ required: true }) status: EngagementStatus;
  @Prop({ type: String, default: null }) error: string | null;
  @Prop({ required: true, type: Date }) at: Date;
  // Primera respuesta del estudiante dentro de REPLY_WINDOW_HOURS
  @Prop({ type: Date, default: null }) replied_at: Date | null;
  @Prop({ type: String, default: null }) reply_text: string | null;
  // Se dio de baja (BAJA) en respuesta a este mensaje
  @Prop({ type: Date, default: null }) opted_out_at: Date | null;

  // Estados de Meta (los reenvía el gateway): id del mensaje en WhatsApp y
  // el estado más avanzado reportado (sent < delivered < read; failed aparte)
  @Prop({ type: String, default: null }) wamid: string | null;
  @Prop({ type: String, default: null }) meta_status:
    | 'sent'
    | 'delivered'
    | 'read'
    | 'failed'
    | null;
  @Prop({ type: Date, default: null }) delivered_at: Date | null;
  @Prop({ type: Date, default: null }) read_at: Date | null;
  @Prop({ type: String, default: null }) meta_error: string | null;
  // Primer clic en el botón del mensaje (?ref=<id> en el enlace).
  // click_tracked: el enlace llevaba el ref (ENGAGEMENT_CLICK_REF activo),
  // así la tasa de clic no cuenta envíos que no se podían medir
  @Prop({ type: Date, default: null }) clicked_at: Date | null;
  @Prop({ default: false }) click_tracked: boolean;
}

export const EngagementMessageSchema =
  SchemaFactory.createForClass(EngagementMessage);

EngagementMessageSchema.index(
  { dedupe_key: 1 },
  { unique: true, partialFilterExpression: { dedupe_key: { $type: 'string' } } },
);
EngagementMessageSchema.index({ user_id: 1, at: -1 });
EngagementMessageSchema.index({ organization_id: 1, kind: 1, at: -1 });
EngagementMessageSchema.index({ phone_tail: 1, at: -1 });
EngagementMessageSchema.index(
  { wamid: 1 },
  { partialFilterExpression: { wamid: { $type: 'string' } } },
);
