import {
  ActivityQuestionType,
  QUESTION_TYPES,
  QuestionOption,
  QuestionPair,
} from './schemas/activity-question.schema';

/** Marca del espacio a completar en las preguntas fill_blank. */
export const BLANK = '____';

/** Contenido de una pregunta según su tipo (sin metadatos). */
export interface QuestionContent {
  type: ActivityQuestionType;
  question: string;
  answer: string;
  options: QuestionOption[];
  pairs: QuestionPair[];
  accepted_answers: string[];
  key_points: string[];
  explanation: string;
}

export const TYPE_LABELS: Record<ActivityQuestionType, string> = {
  open: 'abierta',
  single_choice: 'opción única',
  multiple_choice: 'selección múltiple',
  true_false: 'verdadero/falso',
  fill_blank: 'completar',
  ordering: 'ordenar',
  matching: 'relacionar',
};

/** Error de validación con mensaje apto para el usuario. */
export class InvalidQuestionError extends Error {}

const str = (value: unknown) => String(value ?? '').trim();

function strings(list: unknown): string[] {
  return Array.isArray(list) ? list.map(str).filter(Boolean) : [];
}

function truthy(value: unknown): boolean {
  if (typeof value === 'string') {
    return ['true', 'verdadero', 'si', 'sí', 'yes', '1', 'v'].includes(
      value.trim().toLowerCase(),
    );
  }
  return value === true || value === 1;
}

function parseOptions(list: unknown): QuestionOption[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((o) =>
      typeof o === 'string'
        ? { text: str(o), correct: false }
        : { text: str(o?.text), correct: truthy(o?.correct) },
    )
    .filter((o) => o.text);
}

function hasDuplicates(values: string[]): boolean {
  const seen = new Set(values.map((v) => v.toLowerCase()));
  return seen.size !== values.length;
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Valida y normaliza el contenido de una pregunta según su tipo, y deriva
 * `answer` (la respuesta correcta en texto) para los tipos cerrados.
 * Lanza InvalidQuestionError si la pregunta no es válida.
 *
 * - `shuffleOptions`: mezcla las opciones de single/multiple_choice (la IA
 *   tiende a poner la correcta primero).
 * - `fixTypes`: corrige el tipo cuando no cuadra con las respuestas (p. ej.
 *   single_choice con 2 correctas → multiple_choice). Útil con la IA.
 */
export function normalizeQuestion(
  input: Record<string, any>,
  opts: {
    language?: string;
    shuffleOptions?: boolean;
    fixTypes?: boolean;
  } = {},
): QuestionContent {
  let type = str(input.type) as ActivityQuestionType;
  if (!QUESTION_TYPES.includes(type)) {
    throw new InvalidQuestionError(`Tipo de pregunta inválido: "${type}"`);
  }
  const question = str(input.question);
  if (!question) throw new InvalidQuestionError('La pregunta es requerida');

  const out: QuestionContent = {
    type,
    question,
    answer: '',
    options: [],
    pairs: [],
    accepted_answers: [],
    key_points: strings(input.key_points),
    explanation: str(input.explanation),
  };

  switch (type) {
    case 'open': {
      out.answer = str(input.answer);
      if (!out.answer) {
        throw new InvalidQuestionError(
          'La pregunta abierta necesita una respuesta modelo',
        );
      }
      break;
    }

    case 'single_choice':
    case 'multiple_choice': {
      let options = parseOptions(input.options);
      if (options.length < 3 || options.length > 6) {
        throw new InvalidQuestionError('Debe tener entre 3 y 6 opciones');
      }
      if (hasDuplicates(options.map((o) => o.text))) {
        throw new InvalidQuestionError('Hay opciones repetidas');
      }
      const correct = options.filter((o) => o.correct).length;
      if (opts.fixTypes && correct === 1) type = 'single_choice';
      if (opts.fixTypes && correct >= 2) type = 'multiple_choice';
      if (type === 'single_choice' && correct !== 1) {
        throw new InvalidQuestionError(
          'La pregunta de opción única debe tener exactamente 1 opción correcta',
        );
      }
      if (type === 'multiple_choice' && correct < 2) {
        throw new InvalidQuestionError(
          'La pregunta de selección múltiple debe tener al menos 2 opciones correctas',
        );
      }
      if (correct === options.length) {
        throw new InvalidQuestionError(
          'Debe haber al menos una opción incorrecta',
        );
      }
      if (opts.shuffleOptions) options = shuffle(options);
      out.type = type;
      out.options = options;
      out.answer = options
        .filter((o) => o.correct)
        .map((o) => o.text)
        .join('; ');
      break;
    }

    case 'true_false': {
      // Acepta { answer: true/false/"Verdadero"/"Falso" } o, si no viene
      // answer, options [{text, correct}] con "verdadero" primero
      let isTrue: boolean;
      const options = parseOptions(input.options);
      if (input.answer !== undefined && str(input.answer) !== '') {
        isTrue = truthy(input.answer);
      } else if (options.length === 2 && options.some((o) => o.correct)) {
        isTrue = options[0].correct;
      } else {
        throw new InvalidQuestionError(
          'Indica si el enunciado es verdadero o falso',
        );
      }
      const [yes, no] =
        opts.language === 'en' ? ['True', 'False'] : ['Verdadero', 'Falso'];
      out.options = [
        { text: yes, correct: isTrue },
        { text: no, correct: !isTrue },
      ];
      out.answer = isTrue ? yes : no;
      break;
    }

    case 'fill_blank': {
      // Normaliza cualquier "___" / "[blank]" a BLANK
      out.question = question
        .replace(/_{3,}/g, BLANK)
        .replace(/\[(?:blank|espacio)\]/gi, BLANK);
      const blanks = out.question.split(BLANK).length - 1;
      if (blanks !== 1) {
        throw new InvalidQuestionError(
          `La pregunta de completar debe tener exactamente un espacio "${BLANK}"`,
        );
      }
      out.answer = str(input.answer);
      if (!out.answer) {
        throw new InvalidQuestionError(
          'Indica la palabra o frase que completa el espacio',
        );
      }
      out.accepted_answers = strings(input.accepted_answers).filter(
        (a) => a.toLowerCase() !== out.answer.toLowerCase(),
      );
      break;
    }

    case 'ordering': {
      // Las opciones vienen en el orden correcto
      const items = parseOptions(input.options).map((o) => o.text);
      if (items.length < 3 || items.length > 8) {
        throw new InvalidQuestionError('Debe tener entre 3 y 8 elementos');
      }
      if (hasDuplicates(items)) {
        throw new InvalidQuestionError('Hay elementos repetidos');
      }
      out.options = items.map((text) => ({ text, correct: true }));
      out.answer = items.map((t, i) => `${i + 1}. ${t}`).join(' → ');
      break;
    }

    case 'matching': {
      const pairs = (Array.isArray(input.pairs) ? input.pairs : [])
        .map((p: any) => ({ left: str(p?.left), right: str(p?.right) }))
        .filter((p: QuestionPair) => p.left && p.right);
      if (pairs.length < 3 || pairs.length > 8) {
        throw new InvalidQuestionError('Debe tener entre 3 y 8 parejas');
      }
      if (
        hasDuplicates(pairs.map((p) => p.left)) ||
        hasDuplicates(pairs.map((p) => p.right))
      ) {
        throw new InvalidQuestionError(
          'Hay elementos repetidos en las parejas',
        );
      }
      out.pairs = pairs;
      out.answer = pairs.map((p) => `${p.left} → ${p.right}`).join('; ');
      break;
    }
  }

  return out;
}

/** Reparte `total` preguntas entre los tipos elegidos, lo más parejo posible. */
export function distributeTypes(
  total: number,
  types: ActivityQuestionType[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const order = shuffle(types);
  for (let i = 0; i < total; i++) {
    const t = order[i % order.length];
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}
