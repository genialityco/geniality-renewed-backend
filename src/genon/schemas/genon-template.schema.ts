import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { GenOnAction } from './genon-program.schema';

export type GenOnTemplateStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'PAUSED'
  | 'DISABLED';

export interface GenOnTemplateButton {
  type: 'QUICK_REPLY' | 'URL';
  text: string; // máx. 25 caracteres
  /** QUICK_REPLY: qué hace al tocarlo */
  action?: GenOnAction;
}

export interface GenOnApprovedVersion {
  meta_name: string;
  language: string;
  body: string;
  variables: string[];
  buttons: GenOnTemplateButton[];
  version: number;
  approved_at: Date;
}

/**
 * Plantilla de WhatsApp de Gen.ON. El texto usa variables con nombre
 * ({{nombre}}, {{curso}}…); al enviarla a Meta se convierten a {{1}}…{{n}}
 * y `meta_variables` guarda ese orden para armar los envíos.
 *
 * Una plantilla enviada a Meta no se edita en sitio: al cambiar el texto
 * vuelve a borrador con una versión nueva (`meta_name` con sufijo _vN).
 */
@Schema({
  collection: 'genon_templates',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
})
export class GenOnTemplate extends Document {
  // Identificador estable que usan los pasos del flujo (p. ej. "abandon_question")
  @Prop({ required: true, unique: true }) key: string;
  @Prop({ required: true }) label: string;
  @Prop({ default: 'es' }) language: string;
  @Prop({ default: 'UTILITY' }) category: 'UTILITY' | 'MARKETING';
  @Prop({ required: true }) body: string;
  @Prop({ default: '' }) footer: string;
  @Prop({ type: [Object], default: [] }) buttons: GenOnTemplateButton[];
  @Prop({ default: 1 }) version: number;

  // Meta
  @Prop({ type: String, default: 'DRAFT' }) meta_status: GenOnTemplateStatus;
  @Prop({ type: String, default: null }) meta_name: string | null;
  @Prop({ type: String, default: null }) meta_id: string | null;
  // Categoría final (Meta puede cambiarla si no corresponde al contenido)
  @Prop({ type: String, default: null }) meta_category: string | null;
  @Prop({ type: String, default: null }) rejected_reason: string | null;
  @Prop({ type: [String], default: [] }) meta_variables: string[];
  @Prop({ type: Date, default: null }) submitted_at: Date | null;
  // Última versión aprobada: es la que se envía, aunque haya una más nueva
  // en borrador o en revisión
  @Prop({ type: Object, default: null })
  approved: GenOnApprovedVersion | null;
  @Prop({ type: Date, default: null }) synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export const GenOnTemplateSchema = SchemaFactory.createForClass(GenOnTemplate);
