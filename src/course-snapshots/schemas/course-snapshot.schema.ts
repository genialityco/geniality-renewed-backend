import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export type CourseSnapshotKind = 'baseline' | 'daily';

/**
 * Indicadores de un curso congelados en una fecha. Ver
 * CourseSnapshotsService.computeEvent para la definición de cada campo.
 */
export interface CourseSnapshotMetrics {
  enrolled: number;
  completed: number;
  /** completed / enrolled, en % con un decimal */
  completion_rate: number;
  /** Por progreso del curso (misma regla que event-metrics) */
  in_progress: number;
  not_started: number;
  /** Entre los que NO han completado, según su última actividad en el curso */
  active_7d: number;
  active_15d: number;
  active_30d: number;
  inactive_15d: number;
  never_active: number;
  avg_course_progress: number;
  avg_activity_progress: number;
  total_time_ms: number;
  users_with_time: number;
  /** Fecha de finalización medida (completed_at) */
  completed_tracked: number;
  /** Fecha de finalización estimada (certificado o última actividad al 100%) */
  completed_estimated: number;
  completed_unknown_date: number;
  completions_last_30d: number;
  completions_by_month: { month: string; count: number }[];
  days_to_complete_avg: number | null;
  days_to_complete_median: number | null;
  days_to_complete_sample: number;
  with_phone: number;
  /** No completados con teléfono (ausente en snapshots anteriores) */
  not_completed_with_phone?: number;
  /** Con consentimiento efectivo de WhatsApp (ver common/whatsapp-consent.ts) */
  with_whatsapp_opt_in: number;
  /** No completados con teléfono y opt-in: público alcanzable por WhatsApp */
  reachable_not_completed: number;
}

@Schema({
  collection: 'course_snapshots',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
})
export class CourseSnapshot extends Document {
  @Prop({ required: true }) organization_id: string;
  @Prop({ required: true }) event_id: string;
  @Prop() event_name: string;
  @Prop({ required: true }) kind: CourseSnapshotKind;
  // Fecha local (America/Bogota) YYYY-MM-DD a la que corresponde el snapshot
  @Prop({ required: true }) snapshot_date: string;
  // Agrupa los cursos congelados juntos en una misma línea base
  @Prop({ type: String, default: null }) batch_id: string | null;
  @Prop({ type: String, default: null }) label: string | null;
  @Prop({ required: true, type: Date }) taken_at: Date;
  @Prop({ type: String, default: null }) taken_by: string | null;
  @Prop({ required: true }) inactive_days: number;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  metrics: CourseSnapshotMetrics;
}

export const CourseSnapshotSchema =
  SchemaFactory.createForClass(CourseSnapshot);

// Un snapshot diario por curso y fecha (re-ejecutar el mismo día lo reemplaza)
CourseSnapshotSchema.index(
  { event_id: 1, kind: 1, snapshot_date: 1 },
  { unique: true, partialFilterExpression: { kind: 'daily' } },
);
CourseSnapshotSchema.index({ organization_id: 1, kind: 1, taken_at: -1 });
CourseSnapshotSchema.index({ batch_id: 1 });
