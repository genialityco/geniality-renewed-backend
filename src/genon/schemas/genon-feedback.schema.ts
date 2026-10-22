import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Casos de soporte ("Problemas para ingresar", AYUDA) y comentarios ("No era
 * lo que esperaba") que llegan por la conversación de Gen.ON, para que el
 * equipo los atienda y se reporten al cliente.
 */
@Schema({
  collection: 'genon_feedback',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
})
export class GenOnFeedback extends Document {
  @Prop({ required: true }) program_id: string;
  @Prop({ required: true }) organization_id: string;
  @Prop({ required: true }) event_id: string;
  @Prop({ required: true }) user_id: string;
  @Prop({ required: true }) enrollment_id: string;
  @Prop({ required: true }) type: 'support' | 'comment';
  @Prop({ default: '' }) text: string;
  @Prop({ default: '' }) phone: string;
  @Prop({ type: String, default: 'open' }) status: 'open' | 'closed';
  created_at: Date;
  updated_at: Date;
}

export const GenOnFeedbackSchema = SchemaFactory.createForClass(GenOnFeedback);
GenOnFeedbackSchema.index({ program_id: 1, created_at: -1 });
