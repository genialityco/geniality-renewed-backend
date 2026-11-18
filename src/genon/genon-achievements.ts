import { BadRequestException } from '@nestjs/common';

/**
 * Logros del estudiante en un programa Gen.ON (adaptado de los logros del
 * asistente de gen-live-api a cursos). Cada programa define sus hitos (tipo +
 * umbral + título + felicitación); al cumplir uno se registra una sola vez
 * por persona y la plataforma se lo muestra en un aviso y en «Mis logros».
 *
 * Todo cuenta en los cursos del programa:
 * - activitiesCompleted: actividades terminadas
 * - videosCompleted: videos vistos completos (actividades con video al 100 %)
 * - modulesCompleted: módulos con todas sus actividades terminadas
 * - coursesStarted: cursos con al menos una actividad terminada
 * - coursesCompleted: cursos terminados (avance del 100 %)
 * - courseProgress: avance (%) alcanzado en alguno de sus cursos
 * - streakDays: mejor racha de días seguidos estudiando
 * - studyDays: días distintos con estudio (actividad terminada o reto superado)
 * - challengesPassed: retos de conocimiento superados por WhatsApp
 */
export const ACHIEVEMENT_TYPES = [
  'activitiesCompleted',
  'videosCompleted',
  'modulesCompleted',
  'coursesStarted',
  'coursesCompleted',
  'courseProgress',
  'streakDays',
  'studyDays',
  'challengesPassed',
] as const;

export type GenOnAchievementType = (typeof ACHIEVEMENT_TYPES)[number];

export interface GenOnAchievementDef {
  /** Se guarda en cada logro otorgado: cambiarlo cuenta como un logro nuevo */
  id: string;
  enabled: boolean;
  type: GenOnAchievementType;
  threshold: number;
  /** Nombre del logro ("Primer curso terminado") */
  title: string;
  /** Felicitación: {nombre}, {umbral}, {valor} y {singular|plural} según el umbral */
  text?: string;
}

export interface GenOnAchievementsConfig {
  enabled: boolean;
  /** Pestaña «Mis logros» y aviso al conseguirlos */
  show_to_student: boolean;
  /** Grupo de control: se les registra el logro, pero no lo ven */
  holdout_percent: number;
  items: GenOnAchievementDef[];
}

export const ACHIEVEMENT_TYPE_LABELS: Record<GenOnAchievementType, string> = {
  activitiesCompleted: 'Actividades terminadas',
  videosCompleted: 'Videos vistos completos',
  modulesCompleted: 'Módulos terminados',
  coursesStarted: 'Cursos iniciados',
  coursesCompleted: 'Cursos terminados',
  courseProgress: 'Avance en un curso (%)',
  streakDays: 'Días seguidos de racha',
  studyDays: 'Días con estudio',
  challengesPassed: 'Retos superados',
};

/** Felicitación por defecto de cada tipo (si el logro no trae la suya) */
export const DEFAULT_ACHIEVEMENT_TEXTS: Record<GenOnAchievementType, string> = {
  activitiesCompleted: '¡{nombre}, ya terminaste {umbral} {actividad|actividades}!',
  videosCompleted: '¡{nombre}, ya viste {umbral} {video completo|videos completos}!',
  modulesCompleted: '¡{nombre}, ya terminaste {umbral} {módulo|módulos}!',
  coursesStarted: '¡{nombre}, ya empezaste {umbral} {curso|cursos}!',
  coursesCompleted: '¡{nombre}, ya terminaste {umbral} {curso|cursos}! Felicitaciones.',
  courseProgress: '¡{nombre}, llegaste al {umbral} % de avance en un curso!',
  streakDays: '¡{nombre}, estudiaste {umbral} {día|días} seguidos!',
  studyDays: '¡{nombre}, ya sumas {umbral} {día|días} estudiando con nosotros!',
  challengesPassed: '¡{nombre}, ya superaste {umbral} {reto|retos} de conocimiento!',
};

const MAX_ITEMS = 30;
const ID_RE = /^[\w-]{1,40}$/;

export function defaultAchievements(): GenOnAchievementsConfig {
  const item = (
    id: string,
    type: GenOnAchievementType,
    threshold: number,
    title: string,
    text: string,
  ): GenOnAchievementDef => ({ id, enabled: true, type, threshold, title, text });
  return {
    enabled: false,
    show_to_student: true,
    holdout_percent: 0,
    items: [
      item('first_activity', 'activitiesCompleted', 1, 'Primer paso', '¡{nombre}, terminaste tu primera actividad! Así empieza todo.'),
      item('activities_10', 'activitiesCompleted', 10, '10 actividades', '¡{nombre}, ya terminaste {umbral} actividades!'),
      item('videos_5', 'videosCompleted', 5, '5 videos completos', '¡{nombre}, ya viste {umbral} videos completos!'),
      item('videos_25', 'videosCompleted', 25, '25 videos completos', '¡{nombre}, ya viste {umbral} videos completos! Gracias por tu constancia.'),
      item('first_module', 'modulesCompleted', 1, 'Primer módulo', '¡{nombre}, terminaste tu primer módulo!'),
      item('halfway', 'courseProgress', 50, 'Mitad del camino', '¡{nombre}, ya vas en la mitad de un curso!'),
      item('first_course', 'coursesCompleted', 1, 'Primer curso terminado', '¡{nombre}, terminaste tu primer curso! Felicitaciones.'),
      item('courses_3', 'coursesCompleted', 3, '3 cursos terminados', '¡{nombre}, ya terminaste {umbral} cursos!'),
      item('streak_7', 'streakDays', 7, 'Semana constante', '¡{nombre}, estudiaste {umbral} días seguidos!'),
      item('study_days_10', 'studyDays', 10, '10 días de estudio', '¡{nombre}, ya sumas {umbral} días estudiando con nosotros!'),
      item('first_challenge', 'challengesPassed', 1, 'Primer reto superado', '¡{nombre}, superaste tu primer reto de conocimiento!'),
    ],
  };
}

/** Programas sin logros configurados: los de por defecto (apagados). */
export function withAchievementDefaults(
  cfg: Partial<GenOnAchievementsConfig> | null | undefined,
): GenOnAchievementsConfig {
  const base = defaultAchievements();
  if (!cfg) return base;
  return {
    enabled: cfg.enabled ?? base.enabled,
    show_to_student: cfg.show_to_student ?? base.show_to_student,
    holdout_percent: cfg.holdout_percent ?? base.holdout_percent,
    items: Array.isArray(cfg.items) ? cfg.items : base.items,
  };
}

const maxThreshold = (type: GenOnAchievementType) => (type === 'courseProgress' ? 100 : 1000);

/** Valida y limpia lo que envía el admin (lanza con el primer problema). */
export function normalizeAchievements(input: any): GenOnAchievementsConfig {
  if (!input || typeof input !== 'object') {
    throw new BadRequestException('"achievements" debe ser un objeto');
  }
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length > MAX_ITEMS) {
    throw new BadRequestException(`Máximo ${MAX_ITEMS} logros por programa`);
  }
  const seen = new Set<string>();
  const out: GenOnAchievementDef[] = [];
  for (const raw of items) {
    const id = String(raw?.id || '').trim();
    if (!ID_RE.test(id)) {
      throw new BadRequestException(`Clave de logro inválida: "${id}" (letras, números, - y _)`);
    }
    if (seen.has(id)) throw new BadRequestException(`Clave de logro repetida: "${id}"`);
    seen.add(id);
    const type = raw.type as GenOnAchievementType;
    if (!ACHIEVEMENT_TYPES.includes(type)) {
      throw new BadRequestException(`Tipo de logro inválido en "${id}"`);
    }
    const threshold = Math.round(Number(raw.threshold));
    if (!Number.isFinite(threshold) || threshold < 1 || threshold > maxThreshold(type)) {
      throw new BadRequestException(
        `El umbral de "${id}" debe estar entre 1 y ${maxThreshold(type)}`,
      );
    }
    const title = String(raw.title || '').trim().slice(0, 60);
    if (!title) throw new BadRequestException(`El logro "${id}" necesita un título`);
    const text = String(raw.text || '').trim().slice(0, 280);
    out.push({
      id,
      enabled: raw.enabled !== false,
      type,
      threshold,
      title,
      ...(text ? { text } : {}),
    });
  }
  const holdout = Math.round(Number(input.holdout_percent) || 0);
  return {
    enabled: !!input.enabled,
    show_to_student: input.show_to_student !== false,
    holdout_percent: Math.min(90, Math.max(0, holdout)),
    items: out,
  };
}

/** {nombre}, {umbral}, {valor} y {singular|plural} según el umbral */
export function renderAchievementText(
  template: string,
  vars: { nombre: string; umbral: number; valor?: number },
): string {
  const one = vars.umbral === 1;
  return String(template || '')
    .replace(/\{nombre\}/g, vars.nombre)
    .replace(/\{umbral\}/g, String(vars.umbral))
    .replace(/\{valor\}/g, String(vars.valor ?? vars.umbral))
    .replace(/\{([^{}|]*)\|([^{}|]*)\}/g, (_, s: string, p: string) => (one ? s : p))
    .replace(/\s+/g, ' ')
    .trim();
}

export function achievementText(item: GenOnAchievementDef, nombre: string, valor?: number) {
  return renderAchievementText(item.text || DEFAULT_ACHIEVEMENT_TEXTS[item.type], {
    nombre,
    umbral: item.threshold,
    valor,
  });
}

/** Grupo de control determinista por persona y programa (estable entre reinicios) */
export function achievementHoldout(programId: string, userId: string, percent = 0): boolean {
  if (percent <= 0) return false;
  let h = 0x811c9dc5;
  for (const ch of `${programId}:${userId}:achievements`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100 < percent;
}

/** Lo que hizo la persona en los cursos del programa */
export interface AchievementFacts {
  /** Actividades terminadas (al 100 %) */
  completedActivityIds: Set<string>;
  /** Actividades que son video */
  videoActivityIds: Set<string>;
  /** Módulo → sus actividades */
  modules: Map<string, string[]>;
  /** Curso → sus actividades */
  courseActivities: Map<string, string[]>;
  /** Avance (%) en cada curso donde está inscrita */
  courseProgress: number[];
  bestStreak: number;
  studyDays: number;
  challengesPassed: number;
}

export function achievementProgress(f: AchievementFacts): Record<GenOnAchievementType, number> {
  const done = f.completedActivityIds;
  const all = (ids: string[]) => ids.length > 0 && ids.every((id) => done.has(id));
  return {
    activitiesCompleted: done.size,
    videosCompleted: [...done].filter((id) => f.videoActivityIds.has(id)).length,
    modulesCompleted: [...f.modules.values()].filter(all).length,
    coursesStarted: [...f.courseActivities.values()].filter((ids) => ids.some((id) => done.has(id)))
      .length,
    coursesCompleted: f.courseProgress.filter((p) => p >= 100).length,
    courseProgress: Math.min(100, Math.max(0, ...f.courseProgress.map((p) => Math.round(p)))),
    streakDays: f.bestStreak,
    studyDays: f.studyDays,
    challengesPassed: f.challengesPassed,
  };
}
