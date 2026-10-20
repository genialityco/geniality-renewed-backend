import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, Schema as MongooseSchema } from 'mongoose';
import { CaseResource, CaseStage } from './clinical-case.schema';

export type CaseItemStatus = 'missing' | 'partial' | 'covered';

/** Avance oculto del estudiante en un ítem esperado. */
export interface CaseItemProgress {
  item_id: string;
  status: CaseItemStatus;
  // Nivel de pista con el que llegó a cubrirlo (0 = sin ayuda)
  hint_level: number | null;
  // false = paso condicional que no aplica (no se omitió su condición)
  active?: boolean;
  // Frase textual del estudiante que respalda el crédito (evaluador)
  evidence?: string;
  // Estado fijado por un docente al revisar el intento
  reviewed?: boolean;
}

export interface CaseStageProgress {
  stage_id: string;
  status: 'pending' | 'active' | 'done';
  turns: number;
  // 0 pregunta abierta · 1 señala el hallazgo · 2 acota/contrasta · 3 muy guiada
  hint_level: number;
  items: CaseItemProgress[];
  closed_by: 'mastery' | 'enough' | 'max_turns' | null;
  // Conductas riesgosas propuestas (afectan la nota y la limitan)
  unsafe?: string[];
  // Estudios/conductas sin indicación o distractores elegidos (restan)
  unnecessary?: string[];
}

/** Mensaje de la conversación (+ la evaluación oculta del turno). */
export interface CaseMessage {
  role: 'tutor' | 'student';
  content: string;
  stage: number;
  created_at: Date;
  // Etapas de selección: ids de las opciones elegidas
  selected?: string[];
  // Solo en mensajes del estudiante: lo que detectó el evaluador
  eval?: {
    covered: string[];
    partial: string[];
    misconceptions: string[];
    unsafe: string[];
    asked_for_data: boolean;
    unnecessary?: string[];
    // id del paso → frase del estudiante que lo respalda
    evidence?: Record<string, string>;
  };
  // Solo en mensajes del tutor: decisión de la política
  move?: string;
  // summary: cierre con la retroalimentación (el chat lo muestra enriquecido)
  kind?: 'summary';
}

/** Retroalimentación final del caso. */
export interface CaseFeedback {
  grade?: number | null; // 0-10, un decimal
  comment?: string;
  well_done?: string[];
  could_improve?: string[];
  to_strengthen?: string[];
  topics?: { topic: string; resources: CaseResource[] }[];
  // Seguimiento: lo que le pasó al paciente por lo omitido
  consequences?: { time_label: string; text: string }[];
  // Decisiones de riesgo y propuestas sin indicación
  risks?: string[];
  unnecessary?: string[];
  penalty?: number;
  cap?: number | null;
  reviewed?: boolean;
  strengths: string[];
  to_review: string[];
}

export interface CaseScores {
  diagnosis: number | null; // 0-100
  actions: number | null;
  overall: number | null;
  // Parte de seguimiento: desempeño en el manejo a largo plazo
  followup?: number | null;
  // Pasos cubiertos (antes de penalizaciones)
  coverage?: number | null;
  // 100 − 10 por cada propuesta sin indicación
  precision?: number | null;
  unsafe_count?: number;
  unnecessary_count?: number;
  // Puntos restados por propuestas sin indicación
  penalty?: number;
  // Nota máxima por decisiones de riesgo (0-100), null si no hubo
  cap?: number | null;
}

/** Revisión de un docente: correcciones al evaluador (datos de calibración). */
export interface CaseReview {
  reviewer_id: Types.ObjectId;
  reviewer_name: string;
  reviewed_at: Date;
  note: string;
  // Pasos que el docente revisó (para medir concordancia IA–docente)
  items_checked: number;
  changes: {
    stage: number;
    kind: 'item' | 'unsafe' | 'unnecessary';
    item_id?: string;
    text: string;
    from: string;
    to: string;
    evidence?: string;
  }[];
}

/**
 * Intento de un estudiante sobre un caso clínico. Guarda una copia del caso
 * (si el admin lo edita después, la sesión conserva lo que vio).
 */
@Schema({
  collection: 'clinical_case_sessions',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
})
export class ClinicalCaseSession extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user_id: Types.ObjectId;
  @Prop({ default: '' }) user_name: string;
  @Prop({ default: '' }) email: string;
  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true })
  organization_id: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  event_id: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'ClinicalCase', required: true })
  case_id: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  case_snapshot: {
    title: string;
    presentation: string;
    stages: CaseStage[];
    followup_horizon?: string;
  };

  // acute: el caso · followup: seguimiento a largo plazo (parte 2)
  @Prop({ type: String, default: 'acute' }) part: 'acute' | 'followup';
  // Seguimiento: intento de la parte aguda del que parte
  @Prop({ type: Types.ObjectId, default: null })
  parent_session_id: Types.ObjectId | null;
  // Pasos que omitió al cerrar cada etapa (activan condicionales)
  @Prop({ type: [String], default: [] }) missed_item_ids: string[];
  // Consecuencias por mostrar en el próximo control
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  pending_consequences: { item_id: string; text: string }[];
  // Consecuencias ya mostradas, por etapa
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  consequences_log: { stage: number; time_label: string; texts: string[] }[];

  @Prop({ type: String, default: 'web' }) channel: 'web' | 'whatsapp';
  @Prop({ type: String, default: 'in_progress' }) status:
    | 'in_progress'
    | 'completed'
    | 'abandoned';
  @Prop({ default: 0 }) current_stage: number;
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  stages: CaseStageProgress[];
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  messages: CaseMessage[];

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  scores: CaseScores | null;
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  feedback: CaseFeedback | null;
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  review: CaseReview | null;

  @Prop() started_at: Date;
  @Prop() finished_at: Date;
  created_at: Date;
  updated_at: Date;
}

export const ClinicalCaseSessionSchema =
  SchemaFactory.createForClass(ClinicalCaseSession);
ClinicalCaseSessionSchema.index({ case_id: 1, created_at: -1 });
ClinicalCaseSessionSchema.index({ user_id: 1, case_id: 1, status: 1 });
