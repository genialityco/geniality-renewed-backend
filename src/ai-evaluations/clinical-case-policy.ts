import { CaseExpectedItem, CaseStage } from './schemas/clinical-case.schema';
import {
  CaseItemStatus,
  CaseScores,
  CaseStageProgress,
} from './schemas/clinical-case-session.schema';
import { normalizeText, similarity } from './practice-format';

/**
 * Reglas del agente socrático de casos clínicos, sin IA: cómo se acumula el
 * avance del estudiante, qué hace el tutor en cada turno y cómo se puntúa.
 * La IA solo evalúa (oculto) y redacta; las decisiones son deterministas.
 */

/** Crédito de un ítem según la ayuda que necesitó (índice = nivel de pista). */
const HINT_CREDIT = [1, 0.75, 0.5, 0.25];
// Un ítem "a medias" al cerrar la etapa vale esta fracción
const PARTIAL_FACTOR = 0.4;
const CRITICAL_WEIGHT = 2;
export const MAX_HINT_LEVEL = 3;
// Con lo crítico cubierto, se avanza si deja de progresar tras estos turnos
const MIN_TURNS_TO_ADVANCE_WITHOUT_ALL = 2;
// Precisión: puntos que resta cada propuesta sin indicación (con tope)
const PRECISION_PENALTY = 5;
const MAX_PRECISION_PENALTY = 20;
// Seguridad: nota máxima (0-100) con 1 y con 2+ decisiones de riesgo
const UNSAFE_CAP = [60, 40];

export type TutorMove =
  | 'clarify' // pidió datos del paciente: se responden y se repregunta
  | 'deepen' // avanzó: profundizar en lo que falta
  | 'hint' // no avanzó: pista más concreta
  | 'confront_unsafe' // propuso algo riesgoso: preguntar por sus consecuencias
  | 'challenge' // eligió una opción inadecuada: que la reconsidere
  | 'question_necessity' // propuso algo sin indicación: qué aportaría
  | 'advance' // dominó la etapa (o lo crítico): siguiente etapa
  | 'close_stage'; // agotó los turnos: se modela el razonamiento y se avanza

export interface TurnEvaluation {
  // evidence: frase textual del estudiante que respalda el estado
  items: { id: string; status: CaseItemStatus; evidence?: string }[];
  misconceptions: string[];
  unsafe: string[];
  asked_for_data: boolean;
  // Etapas de selección: distractores elegidos (texto)
  wrong_choices?: string[];
  // Estudios o conductas sin indicación para este paciente
  unnecessary?: string[];
}

const RANK: Record<CaseItemStatus, number> = {
  missing: 0,
  partial: 1,
  covered: 2,
};

export function initialStageProgress(stage: CaseStage): CaseStageProgress {
  return {
    stage_id: stage.id,
    status: 'pending',
    turns: 0,
    hint_level: 0,
    items: stage.expected.map((i) => ({
      item_id: i.id,
      status: 'missing',
      hint_level: null,
      // Los condicionales se activan al entrar a la etapa si se omitió su condición
      active: !i.only_if_missed,
    })),
    closed_by: null,
  };
}

/** Pasos que aplican en la etapa (excluye condicionales no activados). */
export function activeExpected(
  stage: CaseStage,
  progress: CaseStageProgress,
): CaseExpectedItem[] {
  return stage.expected.filter(
    (i) => progress.items.find((p) => p.item_id === i.id)?.active !== false,
  );
}

/** Activa los pasos condicionales cuya condición (un paso omitido) se cumplió. */
export function activateConditional(
  stage: CaseStage,
  progress: CaseStageProgress,
  missed: Set<string>,
) {
  for (const item of stage.expected) {
    if (!item.only_if_missed) continue;
    const p = progress.items.find((x) => x.item_id === item.id);
    if (p) p.active = missed.has(item.only_if_missed);
  }
}

/** Pasos aplicables que quedaron sin plantear al cerrar la etapa. */
export function stageMisses(
  stage: CaseStage,
  progress: CaseStageProgress,
): CaseExpectedItem[] {
  return activeExpected(stage, progress).filter(
    (i) =>
      (progress.items.find((p) => p.item_id === i.id)?.status || 'missing') ===
      'missing',
  );
}

/**
 * Aplica la evaluación del turno: los ítems solo suben de estado (nunca se
 * "pierde" lo ya dicho) y guardan el nivel de pista con que se lograron.
 * Devuelve si hubo progreso y qué ítems subieron.
 */
export function mergeEvaluation(
  progress: CaseStageProgress,
  evaluation: TurnEvaluation,
) {
  const upgraded: { id: string; status: CaseItemStatus }[] = [];
  for (const result of evaluation.items) {
    const item = progress.items.find((i) => i.item_id === result.id);
    if (!item || RANK[result.status] <= RANK[item.status]) continue;
    item.status = result.status;
    item.hint_level = progress.hint_level;
    if (result.evidence) item.evidence = result.evidence;
    upgraded.push({ id: item.item_id, status: result.status });
  }
  return { progressed: upgraded.length > 0, upgraded };
}

export function decideMove(params: {
  stage: CaseStage;
  progress: CaseStageProgress;
  evaluation: TurnEvaluation;
  progressed: boolean;
}): TutorMove {
  const { stage, progress, evaluation, progressed } = params;
  const statusOf = (id: string) =>
    progress.items.find((i) => i.item_id === id)?.status || 'missing';
  const expected = activeExpected(stage, progress);
  const allCovered = expected.every((i) => statusOf(i.id) === 'covered');
  const criticalCovered = expected
    .filter((i) => i.critical)
    .every((i) => statusOf(i.id) === 'covered');

  // Con distractores elegidos no se avanza: primero debe reconsiderarlos
  const wrong = evaluation.wrong_choices?.length || 0;

  if (allCovered && !wrong) return 'advance';
  if (evaluation.asked_for_data && !progressed) return 'clarify';
  if (
    criticalCovered &&
    !progressed &&
    !wrong &&
    progress.turns >= MIN_TURNS_TO_ADVANCE_WITHOUT_ALL
  ) {
    return 'advance';
  }
  // Sin turnos: si ya tiene lo crítico avanza; si no, se modela el razonamiento
  if (progress.turns >= stage.max_turns) {
    return criticalCovered ? 'advance' : 'close_stage';
  }
  if (evaluation.unsafe.length) return 'confront_unsafe';
  if (wrong) return 'challenge';
  if (evaluation.unnecessary?.length && !progressed)
    return 'question_necessity';
  if (progressed) return 'deepen';
  return 'hint';
}

/**
 * Evaluación de una etapa de selección, sin IA: cada opción correcta cubre
 * su paso esperado; los distractores elegidos quedan como elecciones
 * inadecuadas (y riesgosas si están marcados así).
 */
export function evaluateChoice(
  stage: CaseStage,
  selectedIds: string[],
): TurnEvaluation {
  const chosen = stage.options.filter((o) => selectedIds.includes(o.id));
  const distractors = chosen.filter((o) => !o.item_id);
  return {
    items: chosen
      .filter((o) => o.item_id)
      .map((o) => ({
        id: o.item_id as string,
        status: 'covered' as const,
        evidence: o.text,
      })),
    misconceptions: [],
    unsafe: distractors.filter((o) => o.unsafe).map((o) => o.text),
    asked_for_data: false,
    wrong_choices: distractors.map((o) => o.text),
  };
}

/** Ítems que aún no cubre del todo (objetivo del tutor, sin revelarlos). */
export function pendingItems(
  stage: CaseStage,
  progress: CaseStageProgress,
): CaseExpectedItem[] {
  return activeExpected(stage, progress).filter((i) => {
    const p = progress.items.find((x) => x.item_id === i.id);
    return p?.status !== 'covered';
  });
}

function itemCredit(status: CaseItemStatus, hintLevel: number | null) {
  const base = HINT_CREDIT[Math.min(hintLevel ?? 0, MAX_HINT_LEVEL)];
  if (status === 'covered') return base;
  if (status === 'partial') return base * PARTIAL_FACTOR;
  return 0;
}

/**
 * Porcentajes de acierto: diagnóstico (ítems "diagnosis") y acciones
 * (ítems "action"). Las críticas pesan el doble y el crédito baja según la
 * pista que necesitó para llegar.
 */
export function computeScores(
  stages: CaseStage[],
  progress: CaseStageProgress[],
): CaseScores {
  const acc = {
    diagnosis: { got: 0, total: 0 },
    action: { got: 0, total: 0 },
  };
  stages.forEach((stage, s) => {
    if (!progress[s]) return;
    for (const item of activeExpected(stage, progress[s])) {
      const p = progress[s]?.items.find((x) => x.item_id === item.id);
      const weight = item.critical ? CRITICAL_WEIGHT : 1;
      const bucket = acc[item.category] || acc.action;
      bucket.total += weight;
      bucket.got +=
        weight * itemCredit(p?.status || 'missing', p?.hint_level ?? null);
    }
  });
  const pct = (b: { got: number; total: number }) =>
    b.total ? Math.round((b.got / b.total) * 100) : null;
  const all = {
    got: acc.diagnosis.got + acc.action.got,
    total: acc.diagnosis.total + acc.action.total,
  };
  const coverage = pct(all);
  const unsafe = dedupeFlags(progress.flatMap((p) => p?.unsafe || []));
  const unnecessary = dedupeFlags(
    progress.flatMap((p) => p?.unnecessary || []),
  );
  const penalty = Math.min(
    MAX_PRECISION_PENALTY,
    PRECISION_PENALTY * unnecessary.length,
  );
  const cap = unsafe.length
    ? UNSAFE_CAP[Math.min(unsafe.length, UNSAFE_CAP.length) - 1]
    : null;
  let overall = coverage === null ? null : Math.max(0, coverage - penalty);
  if (overall !== null && cap !== null) overall = Math.min(overall, cap);
  return {
    diagnosis: pct(acc.diagnosis),
    actions: pct(acc.action),
    overall,
    coverage,
    precision: Math.max(0, 100 - 10 * unnecessary.length),
    unsafe_count: unsafe.length,
    unnecessary_count: unnecessary.length,
    penalty,
    cap,
  };
}

/** Quita repetidos (el evaluador puede nombrar lo mismo en varios turnos). */
export function dedupeFlags(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const text = String(raw || '').trim();
    if (!text) continue;
    const norm = normalizeText(text);
    if (out.some((x) => similarity(normalizeText(x), norm) >= 0.8)) continue;
    out.push(text);
  }
  return out;
}

/**
 * Acumula en la etapa las conductas riesgosas y las propuestas sin
 * indicación del turno (los distractores no riesgosos cuentan como
 * imprecisión). Devuelve las nuevas de este turno.
 */
export function recordFlags(
  progress: CaseStageProgress,
  evaluation: TurnEvaluation,
) {
  const before = {
    unsafe: progress.unsafe?.length || 0,
    unnecessary: progress.unnecessary?.length || 0,
  };
  progress.unsafe = dedupeFlags([
    ...(progress.unsafe || []),
    ...evaluation.unsafe,
  ]);
  const unsafeNorm = progress.unsafe.map(normalizeText);
  progress.unnecessary = dedupeFlags([
    ...(progress.unnecessary || []),
    ...(evaluation.unnecessary || []),
    ...(evaluation.wrong_choices || []),
  ]).filter((t) => !unsafeNorm.includes(normalizeText(t)));
  return {
    unsafe: progress.unsafe.slice(before.unsafe),
    unnecessary: progress.unnecessary.slice(before.unnecessary),
  };
}

/**
 * ¿La cita del evaluador está realmente en el mensaje del estudiante? Se
 * acepta textual o con la mayoría de sus palabras (errores de tipeo, orden).
 */
export function hasEvidence(quote: string | undefined, studentText: string) {
  const q = normalizeText(quote || '');
  if (q.length < 2) return false;
  const text = normalizeText(studentText);
  if (text.includes(q)) return true;
  const words = q.split(' ').filter((w) => w.length >= 3);
  if (!words.length) return false;
  const hits = words.filter((w) => text.includes(w)).length;
  return hits / words.length >= 0.75;
}

/**
 * ¿El mensaje del tutor revela un ítem pendiente? Coincidencia literal o la
 * mayoría de sus palabras significativas presentes.
 */
export function leaksAnswer(message: string, items: CaseExpectedItem[]) {
  const text = normalizeText(message);
  return items.some((item) => {
    const target = normalizeText(item.text);
    if (target.length >= 12 && text.includes(target)) return true;
    const words = [...new Set(target.split(' ').filter((w) => w.length >= 5))];
    if (words.length < 3) return false;
    const hits = words.filter((w) => text.includes(w)).length;
    return hits / words.length >= 0.8;
  });
}
