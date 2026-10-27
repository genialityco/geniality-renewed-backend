import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { GenOnSegment, GenOnTriggerKey } from './genon-program.schema';

export interface GenOnChallengeRecord {
  activity_id: string;
  at: Date;
  passed: boolean;
  correct: number;
  total: number;
  /** advance: marca la actividad · review: repaso (racha) · video: salta el video */
  kind?: 'advance' | 'review' | 'video';
}

/** Mensaje por disparador esperando su franja. */
export interface GenOnQueued {
  key: GenOnTriggerKey;
  /** Identifica el disparo (no se repite): p. ej. "module:<id>" */
  dedupe: string;
  due_at: Date;
  expires_at: Date;
  template_key: string;
  /** Variables propias del disparo (módulo, video, racha…) y sufijo del enlace */
  data: Record<string, any>;
  /** Se descarta si ya hubo actividad hoy (racha en riesgo) */
  unless_active_today?: boolean;
}

export interface GenOnStreak {
  /** Días de la racha viva (con actividad válida) */
  current: number;
  best: number;
  /** Último día (YYYY-MM-DD) con actividad válida */
  last_day: string | null;
  updated_on: string | null;
}

/** Variante asignada a una persona en un toque con varias. */
export interface GenOnVariantPick {
  template_key: string;
  /** true si podía recibir más de una (cuenta para repartirlas por igual) */
  free: boolean;
  at: Date;
}

/**
 * Estado de una persona en un curso dentro de un programa Gen.ON: su
 * segmento, en qué toque va y cuándo sale el siguiente. Lo actualiza la
 * segmentación diaria y el despacho; la conversación (botones, retos) lo lee.
 *
 * test: inscripción creada desde "Pruebas" para un teléfono de prueba; no
 * marca actividades ni cuenta en métricas, y el motor no la toca.
 */
@Schema({
  collection: 'genon_enrollments',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
})
export class GenOnEnrollment extends Document {
  @Prop({ required: true }) program_id: string;
  @Prop({ required: true }) organization_id: string;
  @Prop({ required: true }) event_id: string;
  @Prop({ required: true }) user_id: string;

  @Prop({ type: String, required: true }) segment: GenOnSegment;
  @Prop({ required: true, type: Date }) segment_since: Date;
  // Último toque enviado (u omitido) de la secuencia del segmento
  @Prop({ type: String, default: null }) last_step_key: string | null;
  @Prop({ type: Number, default: null }) last_step_day: number | null;
  @Prop({ type: Date, default: null }) next_step_at: Date | null;
  @Prop({ type: String, default: null }) next_step_key: string | null;
  // Franja de envío asignada (HH:mm)
  @Prop({ type: String, default: null }) slot: string | null;
  @Prop({ default: false }) holdout: boolean;
  // Variante asignada por toque ("1.2" → plantilla); se mantiene mientras cumpla
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  variant_picks: Record<string, GenOnVariantPick>;

  // Pausa: terminó la secuencia sin responder (o recibió el cierre)
  @Prop({ default: false }) paused: boolean;
  @Prop({ type: Date, default: null }) paused_at: Date | null;
  // Salida: baja o "no era lo que esperaba"
  @Prop({ default: false }) exited: boolean;
  @Prop({ type: String, default: null }) exit_reason: string | null;

  // Datos del último cálculo (para el seguimiento)
  @Prop({ default: 0 }) progress: number;
  @Prop({ default: 0 }) completed_activities: number;
  @Prop({ type: Date, default: null }) last_activity_at: Date | null;
  // Última vez que la segmentación evaluó a esta persona (diaria o al despachar)
  @Prop({ type: Date, default: null }) segmented_at: Date | null;
  @Prop({ type: Date, default: null }) enrolled_at: Date | null;

  // Conversación
  // Últimos 10 dígitos del teléfono al que se escribió: así se reconoce su
  // respuesta y se valida que un botón lo toque la misma persona
  @Prop({ type: String, default: null }) phone_tail: string | null;
  @Prop({ type: String, default: null }) abandon_reason: string | null;
  // La siguiente respuesta de texto se guarda como comentario
  @Prop({ default: false }) awaiting_feedback: boolean;
  // Hasta cuándo "AYUDA" abre un caso de soporte
  @Prop({ type: Date, default: null }) support_until: Date | null;
  @Prop({ type: Date, default: null }) last_touch_at: Date | null;
  @Prop({ type: String, default: null }) last_error: string | null;
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  challenges: GenOnChallengeRecord[];

  // Disparadores (segmento 3, examen, certificado)
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) queue: GenOnQueued[];
  // Disparos ya encolados o enviados (no se repiten)
  @Prop({ type: [String], default: [] }) fired: string[];
  // Módulos completados ya vistos; null = aún no se tomó la foto inicial
  // (así no se felicita por módulos terminados antes de activar Gen.ON)
  @Prop({ type: [String], default: null }) modules_done: string[] | null;
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  streak: GenOnStreak | null;
  // Días sin estudio que un reto superado "puenteó" (racha recuperada)
  @Prop({ type: [String], default: [] }) streak_bridged: string[];
  // Semana (lunes YYYY-MM-DD) del último aviso de racha en riesgo
  @Prop({ type: String, default: null }) streak_risk_week: string | null;
  // Logros de racha que la plataforma ya le mostró (hito o día de hoy)
  @Prop({ type: [String], default: [] }) streak_seen: string[];

  @Prop({ default: false }) test: boolean;
  // Envíos de prueba: teléfono al que va la conversación
  @Prop({ type: String, default: null }) test_phone: string | null;
  created_at: Date;
  updated_at: Date;
}

export const GenOnEnrollmentSchema =
  SchemaFactory.createForClass(GenOnEnrollment);
GenOnEnrollmentSchema.index(
  { program_id: 1, event_id: 1, user_id: 1, test: 1 },
  { unique: true },
);
GenOnEnrollmentSchema.index({ program_id: 1, next_step_at: 1 });
GenOnEnrollmentSchema.index({ program_id: 1, segment: 1 });
GenOnEnrollmentSchema.index({ phone_tail: 1, updated_at: -1 });
GenOnEnrollmentSchema.index({ program_id: 1, 'queue.due_at': 1 });
