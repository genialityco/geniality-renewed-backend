import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, Schema as MongooseSchema } from 'mongoose';

export type CaseItemCategory = 'diagnosis' | 'action';

// Cómo responde el estudiante en la etapa
export type CaseResponseType = 'open' | 'single_choice' | 'multiple_choice';

/** Opción de una etapa de selección. */
export interface CaseOption {
  id: string;
  text: string;
  // Paso esperado que cubre al elegirla; null = distractor
  item_id: string | null;
  // Distractor peligroso para el paciente (el tutor pregunta por sus riesgos)
  unsafe: boolean;
  // Por qué no es adecuado (guía al tutor; no se muestra al estudiante)
  why_not: string;
}

/** Dónde estudiar un paso: actividad del curso + segundo del video. */
export interface CaseResource {
  activity_id: string;
  activity_name: string;
  start_time: number;
}

/** Lo que se espera que el estudiante proponga en una etapa. */
export interface CaseExpectedItem {
  id: string;
  text: string;
  // diagnosis: hipótesis/diagnóstico · action: conducta, examen, tratamiento
  category: CaseItemCategory;
  // Las críticas pesan el doble y son necesarias para avanzar por dominio
  critical: boolean;
  // Por qué es lo esperado (guía al tutor; se muestra al final)
  rationale: string;
  // Dónde se explica en los videos del curso (precalculado, editable)
  resources?: CaseResource[];
  // Seguimiento a largo plazo: qué le pasa al paciente si el estudiante no
  // lo plantea (aparece en el siguiente control)
  if_missed?: string;
  // Paso condicional: solo se espera si antes se omitió el paso con este id
  // (p. ej. "referir a oftalmología" si no se pidió el tamizaje)
  only_if_missed?: string | null;
}

/** Una etapa de la enfermedad: información nueva + "¿qué harías ahora?". */
export interface CaseStage {
  id: string;
  title: string;
  // Seguimiento: momento del control ("6 meses después", "2 años"…)
  time_label?: string;
  // Información que se revela al llegar a la etapa (evolución, laboratorios…)
  reveal: string;
  question: string;
  // open: texto libre · single/multiple_choice: elige entre `options`
  response_type: CaseResponseType;
  options: CaseOption[];
  expected: CaseExpectedItem[];
  // Errores frecuentes: ayudan al evaluador a reconocer ideas equivocadas
  common_errors: string[];
  // Turnos del estudiante antes de cerrar la etapa modelando el razonamiento
  max_turns: number;
}

/**
 * Caso clínico para el agente socrático (por curso y, opcionalmente, por
 * actividad). Por ahora lo redacta la IA a partir del contenido del curso;
 * `reviewed` marca los validados por un profesional.
 */
@Schema({
  collection: 'clinical_cases',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
})
export class ClinicalCase extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true })
  organization_id: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true, index: true })
  event_id: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Activity', default: null })
  activity_id: Types.ObjectId | null;

  @Prop({ required: true }) title: string;
  // Descripción corta para el estudiante (sin revelar el diagnóstico)
  @Prop({ default: '' }) summary: string;
  // Presentación inicial del paciente
  @Prop({ required: true }) presentation: string;
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  stages: CaseStage[];

  // Parte 2: seguimiento a largo plazo (se habilita al terminar la parte
  // aguda). Las consecuencias de lo omitido aparecen en los controles.
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  followup_stages: CaseStage[];
  // Horizonte del seguimiento, para el estudiante (ej. "5 años")
  @Prop({ default: '' }) followup_horizon: string;

  // Visible para los estudiantes
  @Prop({ default: false }) enabled: boolean;
  @Prop({ type: String, default: 'ai' }) source: 'ai' | 'manual';
  // Validado por un profesional certificado
  @Prop({ default: false }) reviewed: boolean;
  @Prop({ default: '' }) reviewed_by: string;

  @Prop({ type: Types.ObjectId, ref: 'User' }) created_by: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User' }) updated_by: Types.ObjectId;
  created_at: Date;
  updated_at: Date;
}

export const ClinicalCaseSchema = SchemaFactory.createForClass(ClinicalCase);
ClinicalCaseSchema.index({ organization_id: 1, event_id: 1, created_at: -1 });
