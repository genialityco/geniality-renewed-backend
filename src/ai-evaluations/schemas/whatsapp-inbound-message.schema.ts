import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Mensajes entrantes ya procesados (por wamid). Meta reintenta el webhook
 * si no le confirman a tiempo: sin esto, un reintento que llega después de
 * reiniciar el backend se respondería otra vez. Mongo los borra a los 7 días.
 */
@Schema({ collection: 'whatsapp_inbound_messages' })
export class WhatsappInboundMessage extends Document {
  @Prop({ required: true, unique: true }) wamid: string;
  @Prop({ required: true }) phone: string;
  @Prop({ required: true, type: Date }) received_at: Date;
}

export const WhatsappInboundMessageSchema = SchemaFactory.createForClass(
  WhatsappInboundMessage,
);

WhatsappInboundMessageSchema.index(
  { received_at: 1 },
  { expireAfterSeconds: 7 * 24 * 3600 },
);
