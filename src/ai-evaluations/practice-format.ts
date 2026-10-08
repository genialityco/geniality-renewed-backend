import {
  InteractiveMessage,
  OutboundMessage,
} from 'src/reminders/whatsapp-gateway.client';
import { PracticeQuestion } from './schemas/practice-session.schema';
import { BLANK } from './question-types';

/**
 * Presentación de las preguntas del banco por WhatsApp y calificación
 * determinista de los tipos cerrados (sin IA). Funciones puras.
 */

const LETTERS = 'abcdefghij';

/** Prefijo de los ids de botones/filas del simulacro: pq:<sesión>:<pregunta>:<valor> */
export const REPLY_PREFIX = 'pq';

export function normalizeText(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Similitud de Dice sobre bigramas (0-1) entre textos ya normalizados. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const grams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) || 0);
  const total = Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0);
  return total ? (2 * inter) / total : 0;
}

function shuffle(n: number): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  // Evita mostrar el orden correcto tal cual
  if (n > 1 && out.every((v, i) => v === i))
    [out[0], out[1]] = [out[1], out[0]];
  return out;
}

/** Orden de presentación de ordering (options) y matching (columna derecha). */
export function buildShuffle(
  q: Pick<PracticeQuestion, 'type' | 'options' | 'pairs'>,
) {
  if (q.type === 'ordering') return shuffle(q.options.length);
  if (q.type === 'matching') return shuffle(q.pairs.length);
  return [];
}

/** "12:30" a partir de segundos */
export function formatTime(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

const TYPE_TITLE: Record<string, string> = {
  open: 'Pregunta abierta',
  single_choice: 'Opción única',
  multiple_choice: 'Selección múltiple',
  true_false: 'Verdadero o falso',
  fill_blank: 'Completa el espacio',
  ordering: 'Ordena',
  matching: 'Relaciona',
};

const FOOTER = 'Escribe "saltar" para pasar o "salir" para terminar';

export function replyId(sessionId: string, index: number, value: string) {
  return `${REPLY_PREFIX}:${sessionId}:${index}:${value}`;
}

/** Mensaje de WhatsApp con la pregunta `index` del simulacro. */
export function formatQuestion(
  q: PracticeQuestion,
  index: number,
  total: number,
  sessionId: string,
): OutboundMessage {
  const head = `*Pregunta ${index + 1}/${total}* · ${TYPE_TITLE[q.type] || ''}\n_${q.activity_name}_\n\n`;
  const id = (value: string) => replyId(sessionId, index, value);

  switch (q.type) {
    case 'true_false':
      return {
        body: `${head}${q.question}\n\n¿Verdadero o falso?`,
        footer: FOOTER,
        buttons: [
          { id: id('v'), title: 'Verdadero' },
          { id: id('f'), title: 'Falso' },
        ],
      };

    case 'single_choice': {
      const lines = q.options.map((o, i) => `*${LETTERS[i]})* ${o.text}`);
      const message: InteractiveMessage = {
        body: `${head}${q.question}\n\n${lines.join('\n')}`,
        footer: FOOTER,
      };
      if (q.options.length <= 3) {
        message.buttons = q.options.map((_, i) => ({
          id: id(LETTERS[i]),
          title: `Opción ${LETTERS[i].toUpperCase()}`,
        }));
      } else {
        message.list = {
          button: 'Elegir respuesta',
          sections: [
            {
              rows: q.options.map((o, i) => ({
                id: id(LETTERS[i]),
                title: `Opción ${LETTERS[i].toUpperCase()}`,
                description: o.text,
              })),
            },
          ],
        };
      }
      return message;
    }

    case 'multiple_choice': {
      const lines = q.options.map((o, i) => `*${LETTERS[i]})* ${o.text}`);
      return `${head}${q.question}\n\n${lines.join('\n')}\n\n👉 Responde con las letras de *todas* las correctas, separadas por coma (ej: a, c).\n\n_${FOOTER}_`;
    }

    case 'fill_blank':
      return `${head}${q.question.replace(BLANK, '______')}\n\n👉 Escribe la palabra o frase que completa el espacio.\n\n_${FOOTER}_`;

    case 'ordering': {
      const lines = q.shuffle.map(
        (idx, i) => `*${LETTERS[i]})* ${q.options[idx].text}`,
      );
      return `${head}${q.question}\n\n${lines.join('\n')}\n\n👉 Responde con las letras en el orden correcto (ej: ${LETTERS.slice(0, q.options.length).split('').reverse().join(', ')}).\n\n_${FOOTER}_`;
    }

    case 'matching': {
      const left = q.pairs.map((p, i) => `*${i + 1}.* ${p.left}`);
      const right = q.shuffle.map(
        (idx, i) => `*${LETTERS[i]})* ${q.pairs[idx].right}`,
      );
      return `${head}${q.question}\n\n${left.join('\n')}\n\n${right.join('\n')}\n\n👉 Responde uniendo número y letra (ej: 1b, 2a, 3c).\n\n_${FOOTER}_`;
    }

    default:
      return `${head}${q.question}\n\n👉 Responde con tus palabras (1 a 4 frases).\n\n_${FOOTER}_`;
  }
}

/** Respuesta correcta legible, para la retroalimentación. */
export function correctAnswerText(q: PracticeQuestion): string {
  switch (q.type) {
    case 'single_choice':
    case 'multiple_choice':
      return q.options
        .map((o, i) => (o.correct ? `${LETTERS[i]}) ${o.text}` : null))
        .filter(Boolean)
        .join('\n');
    case 'ordering': {
      // Letras con las que se mostraron, en el orden correcto
      const letterOf = (optionIdx: number) =>
        LETTERS[q.shuffle.indexOf(optionIdx)];
      return q.options
        .map((o, i) => `${i + 1}. ${letterOf(i)}) ${o.text}`)
        .join('\n');
    }
    case 'matching': {
      const letterOf = (pairIdx: number) => LETTERS[q.shuffle.indexOf(pairIdx)];
      return q.pairs
        .map((p, i) => `${i + 1}${letterOf(i)}: ${p.left} → ${p.right}`)
        .join('\n');
    }
    default:
      return q.answer;
  }
}

// ─── Calificación ─────────────────────────────────────────────────────────

export type GradeResult =
  | { kind: 'graded'; score: number; correct: boolean; answer: string }
  | { kind: 'invalid'; hint: string }
  // Requiere IA: abierta, o completar sin coincidencia clara
  | { kind: 'needs_ai' };

/** Valor elegido en un botón/fila de esta pregunta, o null. */
function replyValue(
  replyIdRaw: string | undefined,
  sessionId: string,
  index: number,
) {
  if (!replyIdRaw) return null;
  const [prefix, sid, idx, value] = replyIdRaw.split(':');
  if (prefix !== REPLY_PREFIX || sid !== sessionId || Number(idx) !== index)
    return null;
  return value || null;
}

/**
 * Letras (a, b, ...) válidas para `n` opciones en el texto: "a, c", "a y c",
 * "A C", "ac", "opción b".
 */
export function parseLetters(text: string, n: number): string[] {
  const valid = LETTERS.slice(0, n);
  // Palabras de relleno ("la a y la c"); "e" solo es conjunción si no es una opción
  const filler =
    n >= 5
      ? 'opcion|opciones|letra|letras|la|las|y'
      : 'opcion|opciones|letra|letras|la|las|y|e';
  const norm = normalizeText(text).replace(
    new RegExp(`\\b(${filler})\\b`, 'g'),
    ' ',
  );
  const tokens = norm.split(' ').filter(Boolean);
  if (!tokens.length) return [];
  // "ac" / "cab": un solo token formado solo por letras válidas
  if (
    tokens.length === 1 &&
    tokens[0].length <= n &&
    [...tokens[0]].every((c) => valid.includes(c))
  ) {
    return [...tokens[0]];
  }
  if (tokens.every((t) => t.length === 1 && valid.includes(t))) return tokens;
  return [];
}

const TRUE_WORDS = new Set([
  'v',
  'verdadero',
  'verdadera',
  'true',
  'si',
  'cierto',
  'correcto',
  't',
]);
const FALSE_WORDS = new Set([
  'f',
  'falso',
  'falsa',
  'false',
  'no',
  'incorrecto',
]);

/**
 * Califica la respuesta según el tipo. Los tipos cerrados se califican aquí;
 * abierta (y completar sin coincidencia clara) devuelven needs_ai.
 */
export function gradeAnswer(
  q: PracticeQuestion,
  text: string,
  replyIdRaw: string | undefined,
  sessionId: string,
  index: number,
): GradeResult {
  const picked = replyValue(replyIdRaw, sessionId, index);
  const n = q.options.length;

  switch (q.type) {
    case 'true_false': {
      const value = picked ?? normalizeText(text).split(' ')[0];
      let isTrue: boolean | null = null;
      if (TRUE_WORDS.has(value)) isTrue = true;
      else if (FALSE_WORDS.has(value)) isTrue = false;
      if (isTrue === null) {
        return {
          kind: 'invalid',
          hint: 'Responde *Verdadero* o *Falso* (también vale V o F).',
        };
      }
      const correct = q.options[0].correct === isTrue;
      return {
        kind: 'graded',
        score: correct ? 100 : 0,
        correct,
        answer: isTrue ? 'Verdadero' : 'Falso',
      };
    }

    case 'single_choice': {
      let letters = picked ? [picked] : parseLetters(text, n);
      // También vale escribir el texto de la opción
      if (!letters.length) {
        const norm = normalizeText(text);
        const match = q.options.findIndex(
          (o) => similarity(normalizeText(o.text), norm) >= 0.85,
        );
        if (match >= 0) letters = [LETTERS[match]];
      }
      if (letters.length !== 1) {
        return {
          kind: 'invalid',
          hint: `Responde con *una* letra (${LETTERS.slice(0, n).split('').join(', ')}).`,
        };
      }
      const idx = LETTERS.indexOf(letters[0]);
      const correct = Boolean(q.options[idx]?.correct);
      return {
        kind: 'graded',
        score: correct ? 100 : 0,
        correct,
        answer: letters[0],
      };
    }

    case 'multiple_choice': {
      const letters = [...new Set(parseLetters(text, n))];
      if (!letters.length) {
        return {
          kind: 'invalid',
          hint: 'Responde con las letras de todas las correctas, separadas por coma (ej: a, c).',
        };
      }
      const chosen = new Set(letters.map((l) => LETTERS.indexOf(l)));
      const totalCorrect = q.options.filter((o) => o.correct).length;
      let hits = 0;
      let wrong = 0;
      chosen.forEach((i) => (q.options[i]?.correct ? hits++ : wrong++));
      const correct = hits === totalCorrect && wrong === 0;
      // Crédito parcial: aciertos menos errores sobre el total de correctas
      const score = correct
        ? 100
        : Math.max(0, Math.round(((hits - wrong) / totalCorrect) * 100));
      return {
        kind: 'graded',
        score,
        correct,
        answer: letters.sort().join(', '),
      };
    }

    case 'ordering': {
      const letters = parseLetters(text, n);
      if (letters.length !== n || new Set(letters).size !== n) {
        return {
          kind: 'invalid',
          hint: `Responde con las ${n} letras en orden, sin repetir (ej: ${LETTERS.slice(0, n).split('').reverse().join(', ')}).`,
        };
      }
      // Letra mostrada → índice real en options (orden correcto)
      const order = letters.map((l) => q.shuffle[LETTERS.indexOf(l)]);
      const hits = order.filter((optionIdx, pos) => optionIdx === pos).length;
      const correct = hits === n;
      return {
        kind: 'graded',
        score: Math.round((hits / n) * 100),
        correct,
        answer: letters.join(', '),
      };
    }

    case 'matching': {
      const pairs = q.pairs.length;
      const found = new Map<number, string>();
      const norm = normalizeText(text).replace(/\s+/g, '');
      for (const m of norm.matchAll(/(\d{1,2})([a-j])/g)) {
        const num = Number(m[1]);
        if (num >= 1 && num <= pairs && LETTERS.indexOf(m[2]) < pairs)
          found.set(num, m[2]);
      }
      if (found.size !== pairs) {
        return {
          kind: 'invalid',
          hint: `Une los ${pairs} números con su letra (ej: 1b, 2a, 3c).`,
        };
      }
      let hits = 0;
      found.forEach((letter, num) => {
        if (q.shuffle[LETTERS.indexOf(letter)] === num - 1) hits++;
      });
      const correct = hits === pairs;
      const answer = [...found.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([num, l]) => `${num}${l}`)
        .join(', ');
      return {
        kind: 'graded',
        score: Math.round((hits / pairs) * 100),
        correct,
        answer,
      };
    }

    case 'fill_blank': {
      const norm = normalizeText(text);
      if (!norm)
        return {
          kind: 'invalid',
          hint: 'Escribe la palabra o frase que completa el espacio.',
        };
      const valid = [q.answer, ...(q.accepted_answers || [])].map(
        normalizeText,
      );
      const best = Math.max(...valid.map((v) => similarity(v, norm)));
      if (valid.includes(norm) || best >= 0.85) {
        return {
          kind: 'graded',
          score: 100,
          correct: true,
          answer: text.trim(),
        };
      }
      // Podría ser un sinónimo o una variante: decide la IA
      if (best >= 0.4 || norm.split(' ').length <= 6)
        return { kind: 'needs_ai' };
      return { kind: 'graded', score: 0, correct: false, answer: text.trim() };
    }

    default:
      return { kind: 'needs_ai' };
  }
}
