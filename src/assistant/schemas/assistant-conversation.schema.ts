import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export interface AssistantToolCall {
  name: string;
  args: Record<string, any>;
  ok: boolean;
}

export interface AssistantTurn {
  role: 'user' | 'assistant';
  text: string;
  at: Date;
  organization_id: string | null;
  /** Herramientas que usó el asistente para responder (auditoría) */
  tools?: AssistantToolCall[];
}

export interface AssistantOrgOption {
  organization_id: string;
  user_id: string;
  name: string;
}

/**
 * Conversación del asistente con un teléfono: la organización elegida (si
 * pertenece a varias con el asistente habilitado), los turnos y el conteo
 * diario para el tope. Una por teléfono (últimos 10 dígitos).
 */
@Schema({
  collection: 'assistant_conversations',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
})
export class AssistantConversation extends Document {
  @Prop({ required: true, unique: true }) phone_tail: string;
  @Prop({ required: true }) phone: string;
  @Prop({ type: String, default: null }) organization_id: string | null;
  @Prop({ type: String, default: null }) user_id: string | null;
  // Cuentas del número cuando eligió: si cambian (otra organización activó el
  // asistente, otra persona con el mismo número), se vuelve a preguntar
  @Prop({ type: String, default: null }) options_key: string | null;
  // Esperando que elija organización: opciones y la pregunta que hizo
  @Prop({ type: [MongooseSchema.Types.Mixed], default: null })
  choosing: AssistantOrgOption[] | null;
  @Prop({ type: String, default: null }) pending_question: string | null;
  // Últimos turnos (se guardan hasta 200)
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) turns: AssistantTurn[];
  // Tope diario: día local (YYYY-MM-DD) y mensajes de ese día
  @Prop({ type: String, default: null }) day: string | null;
  @Prop({ default: 0 }) day_count: number;
  @Prop({ type: Date, default: null }) last_at: Date | null;
}

export const AssistantConversationSchema =
  SchemaFactory.createForClass(AssistantConversation);
AssistantConversationSchema.index({ organization_id: 1, last_at: -1 });
