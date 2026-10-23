import {
  GenOnChallengeConfig,
  GenOnFlowSegment,
  GenOnReply,
  GenOnSegmentRules,
  GenOnStep,
  GenOnTriggersConfig,
} from './schemas/genon-program.schema';
import { GenOnTemplateButton } from './schemas/genon-template.schema';

/**
 * Valores iniciales tomados del documento "Gen.ON Adherencia Educación —
 * Flujo de mensajes por segmento (v2)". Los textos son ejemplos: el equipo
 * de profesionales de la salud los revisa en el admin antes de enviarlos a
 * Meta. Ajustados a las reglas de Meta: ninguna plantilla empieza ni termina
 * con una variable, y los enlaces van en botones.
 */

const OPT_OUT_BUTTON: GenOnTemplateButton = {
  type: 'QUICK_REPLY',
  text: 'No recibir más mensajes',
  action: 'reply:opt_out',
};

const urlButton = (text: string): GenOnTemplateButton => ({
  type: 'URL',
  text,
});

export const DEFAULT_TEMPLATES: {
  key: string;
  label: string;
  body: string;
  buttons: GenOnTemplateButton[];
}[] = [
  {
    key: 'abandon_question',
    label: '1.1 Pregunta de abandono',
    body: 'Hola, {{nombre}}. Tienes una inscripción activa en el curso {{curso}}. Vemos en tu cuenta que no se registra avance reciente. ¿Tienes algún inconveniente técnico que podamos solucionar?',
    buttons: [
      { type: 'QUICK_REPLY', text: 'No he tenido tiempo', action: 'reply:no_time' },
      { type: 'QUICK_REPLY', text: 'Lo retomo pronto', action: 'reply:soon' },
      { type: 'QUICK_REPLY', text: 'Problemas para ingresar', action: 'reply:access' },
      { type: 'QUICK_REPLY', text: 'No era lo que esperaba', action: 'reply:not_expected' },
      OPT_OUT_BUTTON,
    ],
  },
  {
    key: 'social_graduates',
    label: '1.2 Social: egresados',
    body: 'Hola, {{nombre}}. Te informamos que {{n_egresados}} usuarios han finalizado el programa {{curso}} en el que estás inscrito. Tu primera actividad requiere {{min_actividad}} minutos para completarse.',
    buttons: [OPT_OUT_BUTTON, urlButton('Retomar el curso')],
  },
  {
    key: 'social_week',
    label: '1.2 Social: activos de la semana (variante)',
    body: 'Hola, {{nombre}}. Resumen de actividad de {{curso}}: esta semana {{n_activos_semana}} usuarios registraron avance. Tienes una actividad pendiente de {{min_actividad}} minutos en tu cuenta.',
    buttons: [OPT_OUT_BUTTON, urlButton('Retomar el curso')],
  },
  {
    key: 'challenge_first',
    label: '1.3 Reto de la primera actividad',
    body: 'Hola, {{nombre}}. Tienes una evaluación formativa disponible en tu cuenta para el módulo {{tema_actividad}}. Consta de {{num_preguntas}} preguntas y permite acreditar la actividad correspondiente.',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Acepto el reto', action: 'challenge' },
      { type: 'QUICK_REPLY', text: 'Ahora no', action: 'reply:later' },
      OPT_OUT_BUTTON,
    ],
  },
  {
    key: 'closing_abandon',
    label: '1.4 Cierre (abandono)',
    body: 'Hola, {{nombre}}. Te confirmamos que hemos pausado las notificaciones sobre el programa {{curso}}. Tu inscripción sigue activa en el sistema y puedes continuar posteriormente.',
    buttons: [urlButton('Retomar el curso')],
  },
  {
    key: 'motivation',
    label: '2.1 Motivación',
    body: 'Hola, {{nombre}}. Este es tu reporte de estado: llevas un {{avance}} % completado en el programa {{curso}}. La actividad pendiente en tu plan de estudios es {{actividad_pendiente}} (duración estimada: {{min_actividad}} minutos).',
    buttons: [OPT_OUT_BUTTON, urlButton('Continuar donde quedé')],
  },
  {
    key: 'social_from_here',
    label: '2.2 Social: terminaron desde tu punto',
    body: 'Hola, {{nombre}}. Actualización sobre tu progreso: te encuentras en {{modulo_actual}} del programa. Restan {{actividades_restantes}} actividades para finalizar. Dato académico: el {{pct_terminaron_desde_aqui}} % de los usuarios en esta etapa completan el curso.',
    buttons: [OPT_OUT_BUTTON, urlButton('Retomar ahora')],
  },
  {
    key: 'social_cohort',
    label: '2.2 Social: avanzaron en 2 semanas (variante)',
    body: 'Hola, {{nombre}}. Te enviamos el reporte quincenal de tu cohorte: {{n_avanzaron}} usuarios registraron avance en {{curso}}. Tu estado actual requiere completar el módulo {{actividad_pendiente}}.',
    buttons: [OPT_OUT_BUTTON, urlButton('Retomar ahora')],
  },
  {
    key: 'challenge_pending',
    label: '2.3 Reto de la actividad pendiente',
    body: 'Hola, {{nombre}}. Tienes habilitada una evaluación corta de {{num_preguntas}} preguntas sobre {{tema_actividad}}. Aprobarla registrará la actividad {{actividad_reto}} como completada en tu historial.',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Acepto el reto', action: 'challenge' },
      { type: 'QUICK_REPLY', text: 'Ahora no', action: 'reply:later' },
      OPT_OUT_BUTTON,
    ],
  },
  {
    key: 'closing_inactive',
    label: '2.4 Cierre (inactivos)',
    body: 'Hola, {{nombre}}. Te notificamos que hemos suspendido temporalmente las alertas de {{curso}}. Se ha guardado tu progreso actual del {{avance}} % en la plataforma.',
    buttons: [urlButton('Seguir el curso')],
  },
  {
    key: 'module_completed',
    label: '3.1 Acompañamiento: terminó un módulo',
    body: 'Hola, {{nombre}}. Confirmación de avance: has finalizado con éxito {{modulo}}. Tu progreso total en {{curso}} es del {{avance}} %. El siguiente módulo programado es {{siguiente_modulo}}.',
    buttons: [OPT_OUT_BUTTON, urlButton('Seguir el curso')],
  },
  {
    key: 'weekly_above',
    label: '3.2 Comparación social (por encima de la mitad)',
    body: 'Hola, {{nombre}}. Este es tu reporte de rendimiento semanal: tu nivel de avance en {{curso}} supera al {{percentil}} % de los usuarios de tu cohorte actual.',
    buttons: [OPT_OUT_BUTTON, urlButton('Seguir el curso')],
  },
  {
    key: 'weekly_below',
    label: '3.2 Comparación con su propia semana',
    body: 'Hola, {{nombre}}. Resumen de tu actividad semanal en {{curso}}: completaste {{actividades_semana}} actividades. Para alcanzar tu próximo objetivo ({{hito}}) es necesario completar {{faltan_hito}} actividades adicionales.',
    buttons: [OPT_OUT_BUTTON, urlButton('Seguir el curso')],
  },
  {
    key: 'video_challenge',
    label: '3.3 Reto del video',
    body: 'Hola, {{nombre}}. Tienes disponible una pregunta de validación de conocimientos para el contenido {{video}}. Aprobarla te permite acreditar la visualización y avanzar al siguiente módulo.',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Responder la pregunta', action: 'challenge_video' },
      { type: 'QUICK_REPLY', text: 'Prefiero ver el video', action: 'reply:watch_video' },
      OPT_OUT_BUTTON,
    ],
  },
  {
    key: 'streak_milestone',
    label: '3.4 Racha: reconocimiento',
    body: 'Hola, {{nombre}}. Reporte de actividad: has completado {{racha}} días consecutivos de conexión en {{curso}}. Se requiere completar una actividad adicional hoy para mantener este registro activo.',
    buttons: [OPT_OUT_BUTTON, urlButton('Ir al curso')],
  },
  {
    key: 'streak_risk',
    label: '3.4 Racha en riesgo',
    body: 'Hola, {{nombre}}. Alerta sobre tu registro de actividad en {{curso}}: tu racha actual de {{racha}} días caducará pronto. Tienes pendiente completar una actividad o evaluación para mantenerla.',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Hacer un reto', action: 'challenge_any' },
      OPT_OUT_BUTTON,
      urlButton('Ir al curso'),
    ],
  },
  {
    key: 'streak_recovery',
    label: '3.4 Racha: recuperación',
    body: 'Hola, {{nombre}}. Notificación de cuenta: tienes la opción de restaurar tu racha de días consecutivos en {{curso}}. Para hacerlo, debes aprobar la evaluación pendiente sobre {{ultima_actividad}}.',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Recuperar mi racha', action: 'challenge_review' },
      OPT_OUT_BUTTON,
    ],
  },
  {
    key: 'exam_reminder',
    label: 'Recordatorio de examen',
    body: 'Hola, {{nombre}}. Notificación de estado: las actividades formativas de {{modulo}} están completas. Tienes habilitado el examen final en GenCampus, el cual es requisito para tu certificación.',
    buttons: [OPT_OUT_BUTTON, urlButton('Presentar examen')],
  },
  {
    key: 'certificate',
    label: 'Certificado listo',
    body: 'Hola, {{nombre}}. Confirmación de finalización: has completado satisfactoriamente el programa {{curso}}. Tu certificado digital ha sido generado y está disponible para descarga.',
    buttons: [urlButton('Descargar certificado')],
  },
];

/** Segmento 3, examen y certificado (orden de prioridad del documento). */
export function defaultTriggers(): GenOnTriggersConfig {
  return {
    priority: [
      'exam_reminder',
      'certificate',
      'streak_risk',
      'streak_recovery',
      'video_challenge',
      'streak_milestone',
      'weekly_social',
      'module_completed',
    ],
    module_completed: { enabled: true, template_key: 'module_completed' },
    weekly_social: {
      enabled: true,
      weekday: 1,
      above_template_key: 'weekly_above',
      below_template_key: 'weekly_below',
    },
    video_challenge: {
      enabled: true,
      template_key: 'video_challenge',
      num_questions: 1,
      pass_text:
        'Correcto. Marcamos {{video}} como visto. 🎉 Sigue con {{actividad_siguiente}}: {{link_siguiente}}',
      fail_text:
        '{{video}} lo explica en {{min_video}} minutos: {{link_reto}}',
    },
    streak: {
      enabled: true,
      milestones: [3, 7, 14, 30],
      milestone_template_key: 'streak_milestone',
      risk_enabled: true,
      risk_time: '19:00',
      risk_min: 3,
      risk_template_key: 'streak_risk',
      recovery_enabled: true,
      recovery_min: 3,
      recovery_template_key: 'streak_recovery',
      recovery_window_days: 2,
    },
    review_challenge: {
      pass_text:
        '¡Bien, {{nombre}}! Acertaste {{aciertos}} de {{total}}: hoy cuenta para tu racha. 🔥 Llevas {{racha}} días.',
      fail_text:
        'Acertaste {{aciertos}} de {{total}}. Repasa {{actividad_reto}} aquí: {{link_reto}}\nPuedes intentarlo de nuevo con otro reto.',
    },
    exam_reminder: {
      enabled: true,
      days_after: 2,
      template_key: 'exam_reminder',
      include_final: true,
    },
    certificate: { enabled: true, template_key: 'certificate' },
  };
}

/**
 * Programas creados antes de la fase 2 no tienen `triggers`: se completan con
 * los valores por defecto (y cada sección con sus campos nuevos).
 */
export function withTriggerDefaults(
  triggers: Partial<GenOnTriggersConfig> | null | undefined,
): GenOnTriggersConfig {
  const base = defaultTriggers();
  if (!triggers) return base;
  const out: any = { ...base };
  for (const key of Object.keys(base) as (keyof GenOnTriggersConfig)[]) {
    const value = (triggers as any)[key];
    if (value === undefined) continue;
    out[key] = Array.isArray(value)
      ? value
      : typeof value === 'object' && value !== null
        ? { ...(base as any)[key], ...value }
        : value;
  }
  return out;
}

export function defaultSegments(): GenOnSegmentRules {
  return {
    abandon: { rule: 'no_activity', max_progress: 5, min_days_enrolled: 7 },
    inactive: { min_progress: 5, min_days_inactive: 15 },
    active: { max_days_inactive: 15 },
  };
}

const single = (template_key: string) => [{ template_key, conditions: [] }];

export function defaultFlows(socialMin = 20): Record<GenOnFlowSegment, GenOnStep[]> {
  return {
    abandon: [
      { key: '1.1', label: 'Pregunta de abandono', day: 0, mechanic: 'abandon_question', variants: single('abandon_question'), enabled: true },
      {
        key: '1.2',
        label: 'Mensaje social',
        day: 3,
        mechanic: 'social',
        variants: [
          { template_key: 'social_graduates', conditions: [{ metric: 'n_egresados', min: socialMin }] },
          { template_key: 'social_week', conditions: [{ metric: 'n_activos_semana', min: socialMin }] },
        ],
        enabled: true,
      },
      { key: '1.3', label: 'Reto de conocimiento', day: 7, mechanic: 'challenge_invite', variants: single('challenge_first'), enabled: true },
      { key: '1.4', label: 'Cierre', day: 14, mechanic: 'closing', variants: single('closing_abandon'), enabled: true },
    ],
    inactive: [
      { key: '2.1', label: 'Motivación', day: 0, mechanic: 'message', variants: single('motivation'), enabled: true },
      {
        key: '2.2',
        label: 'Mensaje social',
        day: 3,
        mechanic: 'social',
        variants: [
          {
            template_key: 'social_from_here',
            conditions: [
              { metric: 'base_desde_aqui', min: socialMin },
              { metric: 'pct_terminaron_desde_aqui', min: 50 },
            ],
          },
          { template_key: 'social_cohort', conditions: [{ metric: 'n_avanzaron', min: socialMin }] },
        ],
        enabled: true,
      },
      { key: '2.3', label: 'Reto de conocimiento', day: 7, mechanic: 'challenge_invite', variants: single('challenge_pending'), enabled: true },
      { key: '2.4', label: 'Cierre', day: 14, mechanic: 'closing', variants: single('closing_inactive'), enabled: true },
    ],
  };
}

/** Respuestas dentro de la conversación (texto libre, no son plantillas). */
export function defaultReplies(): GenOnReply[] {
  return [
    {
      key: 'no_time',
      label: 'No he tenido tiempo',
      text: 'Te entendemos, la consulta no da tregua. La actividad toma {{min_actividad}} minutos. Si prefieres, te enviamos ya {{num_preguntas}} preguntas por aquí y, si las respondes bien, la damos por terminada.',
      buttons: [
        { title: 'Quiero el reto', action: 'challenge' },
        { title: 'Voy al curso', action: 'reply:link' },
      ],
      effect: 'none',
    },
    {
      key: 'soon',
      label: 'Lo retomo pronto',
      text: 'Perfecto. Te dejamos la actividad a un clic: {{link}}',
      buttons: [],
      effect: 'none',
    },
    {
      key: 'access',
      label: 'Problemas para ingresar',
      text: 'Gracias por contarnos. Este es tu acceso directo: {{link}}\nTu usuario es {{correo}}. Si sigue sin funcionar, responde AYUDA y te contacta soporte.',
      buttons: [],
      effect: 'support_case',
    },
    {
      key: 'not_expected',
      label: 'No era lo que esperaba',
      text: 'Gracias por decírnoslo. ¿Qué esperabas encontrar? Tu respuesta llega al equipo académico del curso.',
      buttons: [],
      effect: 'feedback',
    },
    {
      key: 'later',
      label: 'Ahora no',
      text: 'Sin problema. Cuando quieras, aquí está tu actividad: {{link}}',
      buttons: [],
      effect: 'none',
    },
    {
      key: 'link',
      label: 'Voy al curso',
      text: '¡Vamos! Esta es tu actividad: {{link}}',
      buttons: [],
      effect: 'none',
    },
    {
      key: 'opt_out',
      label: 'No recibir más mensajes',
      text: 'Listo, no te escribiremos más por WhatsApp. Si cambias de opinión, responde VOLVER.',
      buttons: [],
      effect: 'opt_out',
    },
    {
      key: 'help',
      label: 'AYUDA (soporte)',
      text: 'Listo, avisamos a soporte y te contactarán pronto.',
      buttons: [],
      effect: 'support_case',
    },
    {
      key: 'feedback_thanks',
      label: 'Gracias por el comentario',
      text: '¡Gracias! Tu comentario llegó al equipo académico.',
      buttons: [],
      effect: 'none',
    },
    {
      key: 'watch_video',
      label: 'Prefiero ver el video',
      text: 'Perfecto. Aquí tienes la actividad: {{link}}',
      buttons: [],
      effect: 'none',
    },
  ];
}

export function defaultChallenge(): GenOnChallengeConfig {
  return {
    num_questions: 3,
    pass_percent: 100,
    retry_after_days: 1,
    intro_text:
      '¡Vamos con el reto! 💪 Son {{num_preguntas}} preguntas sobre {{tema_actividad}}. Responde cada una como se indica.',
    pass_text:
      'Excelente, {{nombre}}. Acertaste {{aciertos}} de {{total}}: marcamos {{actividad_reto}} como terminada. 🎉 Sigue con {{actividad_siguiente}}: {{link_siguiente}}',
    fail_text:
      'Acertaste {{aciertos}} de {{total}}. En {{actividad_reto}} están las claves que faltaron; toma {{min_actividad}} minutos: {{link_reto}}\nPuedes intentar el reto de nuevo desde mañana.',
    unavailable_text:
      'Por ahora no tenemos un reto disponible para esta actividad. Puedes avanzar directamente aquí: {{link}}',
    retry_wait_text:
      'Ya intentaste este reto hace poco. Podrás repetirlo desde mañana; mientras tanto, repasa la actividad: {{link_reto}}',
  };
}

/** Programa nuevo con todos los valores del documento. */
export function defaultProgram() {
  const socialMin = 20;
  return {
    mode: 'off' as const,
    timezone: 'America/Bogota',
    send_slots: ['12:30', '19:00'],
    blocked_weekdays: [0],
    weekly_cap: 2,
    social_min: socialMin,
    default_activity_minutes: 15,
    auto_login_links: false,
    holdout_percent: { abandon: 20, inactive: 20, active: 20 },
    segments: defaultSegments(),
    flows: defaultFlows(socialMin),
    replies: defaultReplies(),
    challenge: defaultChallenge(),
    courses: {},
    triggers: defaultTriggers(),
  };
}
