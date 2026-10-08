import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Último mensaje recibido de cada teléfono. Sirve para saber si la ventana
 * de 24 h de WhatsApp está abierta (se puede enviar texto/interactivo libre)
 * o si hay que usar una plantilla aprobada.
 */
@Schema({
  collection: 'whatsapp_contacts',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
})
export class WhatsappContact extends Document {
  @Prop({ required: true, unique: true }) phone: string;
  @Prop() last_inbound_at: Date;
  created_at: Date;
  updated_at: Date;
}

export const WhatsappContactSchema =
  SchemaFactory.createForClass(WhatsappContact);
