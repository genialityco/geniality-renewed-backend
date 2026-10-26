import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export interface GenOnDemoParticipant {
  /** Usuario ficticio creado para el participante en la organización de prueba */
  user_id: string;
  name: string;
  /** Teléfono con indicativo, solo dígitos */
  phone: string;
  added_at: Date;
}

export interface GenOnDemoSend {
  step_id: string;
  user_id: string;
  at: Date;
  ok: boolean;
  error: string | null;
}

/**
 * Demostración guiada de Gen.ON: un grupo de personas reales, cada una con
 * su usuario ficticio en un curso de la organización de prueba, recorre el
 * guion por etapas (abandono, inactivos, activos…). El presentador prepara
 * cada etapa (deja los datos de todos en esa situación) y envía sus pasos.
 */
@Schema({
  collection: 'genon_demos',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
})
export class GenOnDemo extends Document {
  @Prop({ required: true }) program_id: string;
  @Prop({ required: true }) organization_id: string;
  @Prop({ required: true }) event_id: string;
  @Prop({ required: true }) name: string;
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  participants: GenOnDemoParticipant[];
  // Etapa del guion preparada ahora (null = aún ninguna)
  @Prop({ type: String, default: null }) stage: string | null;
  @Prop({ type: Date, default: null }) stage_prepared_at: Date | null;
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) sends: GenOnDemoSend[];
  @Prop({ type: String, default: null }) created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export const GenOnDemoSchema = SchemaFactory.createForClass(GenOnDemo);
GenOnDemoSchema.index({ program_id: 1, created_at: -1 });
