import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export type GenOnMode = 'off' | 'dry_run' | 'live';
/** Segmentos con secuencia de mensajes (el 3, "active", llega en la fase 2). */
export type GenOnFlowSegment = 'abandon' | 'inactive';
export type GenOnSegment =
  | GenOnFlowSegment
  | 'active'
  | 'graduated'
  // Cumple la regla de abandono pero aún no lleva los días mínimos inscrito
  | 'waiting';

export type GenOnMechanic =
  | 'message'
  | 'abandon_question'
  | 'social'
  | 'challenge_invite'
  | 'closing';

/** Métricas que pueden condicionar una variante (datos sociales y avance). */
export type GenOnMetric =
  | 'n_egresados'
  | 'n_activos_semana'
  | 'n_avanzaron'
  | 'pct_terminaron_desde_aqui'
  | 'base_desde_aqui'
  | 'avance';

export interface GenOnCondition {
  metric: GenOnMetric;
  /** Se cumple si la métrica es >= min */
  min: number;
}

/**
 * Variante de un toque. Entre las que cumplen todas sus condiciones, a cada
 * persona se le asigna una al azar, repartidas por igual. Sin variantes que
 * se cumplan, el toque se omite (p. ej. el dato social bajo, que normaliza
 * el abandono).
 */
export interface GenOnVariant {
  template_key: string;
  conditions: GenOnCondition[];
}

export interface GenOnStep {
  key: string; // "1.1"
  label: string;
  day: number; // días desde la entrada al segmento
  mechanic: GenOnMechanic;
  variants: GenOnVariant[];
  enabled: boolean;
}

/**
 * Acción de un botón (de plantilla o de la conversación):
 * - challenge: reto de avance (marca la actividad si lo supera)
 * - challenge_any: de avance si hay actividad elegible; si no, de repaso
 * - challenge_review: de repaso sobre lo último estudiado (cuenta para la racha)
 * - challenge_video: reto del video saltable (al enviar lleva el id del video)
 * - reply:<clave>: respuesta configurada (ver `replies`), que puede además
 *   abrir un caso, pedir un comentario o dar de baja.
 */
export type GenOnAction =
  | 'challenge'
  | 'challenge_any'
  | 'challenge_review'
  | 'challenge_video'
  | `challenge_video:${string}`
  | `reply:${string}`;

/** Qué pasa además de enviar el texto de una respuesta. */
export type GenOnReplyEffect =
  | 'none'
  | 'support_case' // abre un caso de soporte
  | 'feedback' // la siguiente respuesta de texto se guarda como comentario
  | 'opt_out'; // baja de WhatsApp y sale del flujo

export interface GenOnReply {
  key: string;
  label: string;
  text: string; // con variables {{...}}
  buttons: { title: string; action: GenOnAction }[];
  effect: GenOnReplyEffect;
}

export interface GenOnChallengeConfig {
  num_questions: number;
  pass_percent: number;
  /** Días antes de poder reintentar la misma actividad */
  retry_after_days: number;
  intro_text: string;
  pass_text: string;
  fail_text: string;
  /** Sin preguntas suficientes o sin actividad habilitada */
  unavailable_text: string;
  /** Reintento antes de tiempo */
  retry_wait_text: string;
}

export interface GenOnCourseConfig {
  /** Actividades que se pueden completar superando un reto */
  challenge_activity_ids: string[];
  /** Minutos estimados por actividad (para {{min_actividad}}) */
  activity_minutes: Record<string, number>;
  /** Fase 2: videos que se pueden saltar con el reto del video */
  skippable_activity_ids: string[];
}

/**
 * Mensajes por disparador (segmento 3 y los que aplican a todos): no siguen
 * un calendario, se disparan por lo que la persona hace en el curso.
 */
export type GenOnTriggerKey =
  | 'exam_reminder'
  | 'certificate'
  | 'streak_risk'
  | 'streak_recovery'
  | 'video_challenge'
  | 'streak_milestone'
  | 'weekly_social'
  | 'module_completed';

export interface GenOnTriggersConfig {
  /** Si se disparan varios en la semana, salen en este orden (el tope corta el resto) */
  priority: GenOnTriggerKey[];
  module_completed: { enabled: boolean; template_key: string };
  weekly_social: {
    enabled: boolean;
    /** Día de la semana en que sale (0 = domingo) */
    weekday: number;
    /** Por encima de la mitad de su cohorte: mensaje de aprobación */
    above_template_key: string;
    /** Por debajo: se compara con su propia semana */
    below_template_key: string;
  };
  video_challenge: {
    enabled: boolean;
    template_key: string;
    num_questions: number;
    pass_text: string;
    fail_text: string;
  };
  streak: {
    enabled: boolean;
    milestones: number[];
    milestone_template_key: string;
    risk_enabled: boolean;
    /** Hora local del aviso de racha en riesgo */
    risk_time: string;
    risk_min: number;
    risk_template_key: string;
    recovery_enabled: boolean;
    recovery_min: number;
    recovery_template_key: string;
    /** Días sin estudio que un reto superado puede "puentear" */
    recovery_window_days: number;
  };
  /** Reto de repaso (racha): sobre lo último que estudió, no cambia el avance */
  review_challenge: { pass_text: string; fail_text: string };
  exam_reminder: {
    enabled: boolean;
    days_after: number;
    template_key: string;
    /** También el examen general cuando termina todas las actividades */
    include_final: boolean;
  };
  certificate: { enabled: boolean; template_key: string };
}

export interface GenOnSegmentRules {
  abandon: {
    /** no_activity: ninguna actividad completada · max_progress: avance <= max */
    rule: 'no_activity' | 'max_progress';
    max_progress: number;
    min_days_enrolled: number;
  };
  inactive: { min_progress: number; min_days_inactive: number };
  active: { max_days_inactive: number };
}

/**
 * Programa Gen.ON: a qué organizaciones y cursos aplica, sus reglas de
 * segmentación, la secuencia de toques de cada segmento, los horarios, el
 * tope, el grupo de control y los retos. Todo se edita desde el admin.
 */
@Schema({
  collection: 'genon_programs',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
})
export class GenOnProgram extends Document {
  @Prop({ required: true }) name: string;
  @Prop({ type: String, default: 'off' }) mode: GenOnMode;
  @Prop({ type: [String], default: [] }) organization_ids: string[];
  // Vacío = todos los cursos (con inscritos) de esas organizaciones
  @Prop({ type: [String], default: [] }) event_ids: string[];

  @Prop({ default: 'America/Bogota' }) timezone: string;
  // Franjas de envío HH:mm; a cada persona le toca una al azar (estable)
  @Prop({ type: [String], default: ['12:30', '19:00'] }) send_slots: string[];
  // Días sin envíos (0 = domingo): lo que cae ahí pasa al siguiente día hábil
  @Prop({ type: [Number], default: [0] }) blocked_weekdays: number[];
  @Prop({ default: 2 }) weekly_cap: number;
  @Prop({ default: 20 }) social_min: number;
  @Prop({ default: 15 }) default_activity_minutes: number;
  // % del grupo de control por segmento
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  holdout_percent: Partial<Record<GenOnSegment, number>>;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  segments: GenOnSegmentRules;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  flows: Record<GenOnFlowSegment, GenOnStep[]>;
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  replies: GenOnReply[];
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  challenge: GenOnChallengeConfig;
  // Por curso (event_id)
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  courses: Record<string, GenOnCourseConfig>;
  // Segmento 3, examen y certificado (ver GenOnTriggersConfig)
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  triggers: GenOnTriggersConfig | null;
  // Hasta dónde se revisaron las actividades completadas (disparadores)
  @Prop({ type: Date, default: null }) last_event_check: Date | null;

  // Fecha local (YYYY-MM-DD) de la última segmentación
  @Prop({ type: String, default: null }) last_segmented_on: string | null;
  @Prop({ type: Date, default: null }) last_run_at: Date | null;
  @Prop({ type: String, default: null }) created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export const GenOnProgramSchema = SchemaFactory.createForClass(GenOnProgram);
GenOnProgramSchema.index({ organization_ids: 1, mode: 1 });
