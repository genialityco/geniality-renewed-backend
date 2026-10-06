import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { UsersService } from 'src/users/users.service';
import { Event } from 'src/events/schemas/event.schema';
import { Module as CourseModule } from 'src/modules/schemas/module.schema';
import { Activity } from 'src/activities/schemas/activity.schema';
import {
  TranscriptSegment,
  TranscriptSegmentDocument,
} from 'src/transcript-segments/schemas/transcript-segment.schema';
import {
  Document as CourseDocument,
  DocumentDocument,
} from 'src/documents/schemas/document.schema';
import {
  ActivityQuestion,
  ActivityQuestionDifficulty,
  ActivityQuestionType,
  QUESTION_TYPES,
  QuestionOption,
  QuestionPair,
} from './schemas/activity-question.schema';
import { idVariants } from './course-content.service';
import { GeminiTextClient } from './gemini-text.client';
import {
  BLANK,
  InvalidQuestionError,
  TYPE_LABELS,
  distributeTypes,
  normalizeQuestion,
} from './question-types';

const DIFFICULTIES: ActivityQuestionDifficulty[] = [
  'basic',
  'intermediate',
  'advanced',
];
const DEFAULT_NUM_QUESTIONS = 10;
const MAX_NUM_QUESTIONS = 30;
// ~400k caracteres ≈ 100k tokens ≈ 7 h de clase. Gemini Flash admite 1M.
const MAX_TRANSCRIPT_CHARS =
  Number(process.env.AI_QUESTIONS_MAX_TRANSCRIPT_CHARS) || 400000;
const MAX_DOCUMENTS_CHARS = 50000;
const MIN_CONTENT_CHARS = 300;
// Agrupa los segmentos del transcript en bloques de ~1 min con marca de tiempo
const BLOCK_SECONDS = 60;
const GENERATION_TIMEOUT_MS = 180000;

const DIFFICULTY_HINT: Record<string, string> = {
  basic: 'Todas de nivel básico: definiciones y comprensión de conceptos.',
  intermediate:
    'Todas de nivel intermedio: relación entre conceptos y explicación de procesos.',
  advanced:
    'Todas de nivel avanzado: análisis, aplicación a casos prácticos y toma de decisiones.',
  mixed:
    'Mezcla niveles: aproximadamente 30% básicas, 40% intermedias y 30% avanzadas.',
};

// Instrucciones por tipo para el prompt de generación
const TYPE_RULES: Record<ActivityQuestionType, string> = {
  open: `"open" (abierta): "question" se responde en 1 a 4 frases; "answer" es la respuesta modelo completa (2 a 5 frases); "key_points" tiene 2 a 5 ideas que una respuesta correcta debe contener.`,
  single_choice: `"single_choice" (opción única): "options" tiene 4 opciones {"text", "correct"} con EXACTAMENTE 1 correcta. Los distractores deben ser plausibles (confusiones reales sobre el tema), de longitud y estilo similar a la correcta. Nada de "todas/ninguna de las anteriores".`,
  multiple_choice: `"multiple_choice" (selección múltiple): "options" tiene 5 opciones {"text", "correct"} con 2 o 3 correctas. La pregunta termina con "(selecciona todas las correctas)".`,
  true_false: `"true_false" (verdadero/falso): "question" es un ENUNCIADO afirmativo (no una pregunta) y "answer" es true o false. Alterna enunciados verdaderos y falsos; los falsos alteran sutilmente un hecho explicado en clase.`,
  fill_blank: `"fill_blank" (completar): "question" es una oración con EXACTAMENTE un "${BLANK}" que reemplaza un término clave; "answer" es ese término (1 a 4 palabras) y "accepted_answers" sus variantes o sinónimos válidos.`,
  ordering: `"ordering" (ordenar): "question" es la instrucción (ej. "Ordena los pasos de ..."); "options" tiene 3 a 6 elementos {"text"} EN EL ORDEN CORRECTO. Úsalo solo con procesos, etapas o secuencias explicados en clase.`,
  matching: `"matching" (relacionar): "question" es la instrucción (ej. "Relaciona cada concepto con su definición"); "pairs" tiene 3 a 6 parejas {"left", "right"} correctas, con textos "right" breves y no ambiguos.`,
};

export interface GenerateQuestionsBody {
  num_questions?: number;
  // Tipos a generar (por defecto todos); se reparten de forma pareja
  types?: ActivityQuestionType[];
  difficulty?: ActivityQuestionDifficulty | 'mixed';
  instructions?: string;
  // replace: borra las generadas por IA sin editar; append: agrega nuevas
  mode?: 'replace' | 'append';
}

export interface QuestionInput {
  type?: ActivityQuestionType;
  question?: string;
  answer?: string | boolean;
  options?: QuestionOption[];
  pairs?: QuestionPair[];
  accepted_answers?: string[];
  key_points?: string[];
  explanation?: string;
  difficulty?: ActivityQuestionDifficulty;
  topic?: string;
  start_time?: number | null;
  enabled?: boolean;
  order?: number;
}

interface ActivityMaterial {
  text: string;
  hasTranscript: boolean;
  timestamped: boolean;
  transcriptChars: number;
  truncated: boolean;
}

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 75 → "1:15", 3725 → "1:02:05" */
function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "1:15" / "1:02:05" / 75 → segundos; null si no se puede interpretar. */
function parseTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  const match = String(value ?? '')
    .trim()
    .match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return (
    Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3])
  );
}

// Campos del contenido de la pregunta (ver normalizeQuestion)
const CONTENT_FIELDS = [
  'type',
  'question',
  'answer',
  'options',
  'pairs',
  'accepted_answers',
  'key_points',
  'explanation',
] as const;

/**
 * Banco de preguntas por actividad: generación con IA (información del curso
 * + transcript completo del video + documentos de la actividad) y CRUD para
 * el admin. Colección `activity_questions`.
 */
@Injectable()
export class ActivityQuestionsService {
  private readonly logger = new Logger(ActivityQuestionsService.name);
  // Evita dos generaciones simultáneas de la misma actividad (una instancia)
  private readonly generating = new Set<string>();

  constructor(
    @InjectModel(ActivityQuestion.name)
    private readonly questionModel: Model<ActivityQuestion>,
    @InjectModel(Activity.name)
    private readonly activityModel: Model<Activity>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel('Module') private readonly moduleModel: Model<CourseModule>,
    @InjectModel(TranscriptSegment.name)
    private readonly segmentModel: Model<TranscriptSegmentDocument>,
    @InjectModel(CourseDocument.name)
    private readonly documentModel: Model<DocumentDocument>,
    private readonly usersService: UsersService,
    private readonly gemini: GeminiTextClient,
  ) {}

  // ─── Consulta ──────────────────────────────────────────────────────────

  async list(organizationId: string, activityId: string) {
    const { activity } = await this.findActivityInOrg(
      organizationId,
      activityId,
    );
    const questions = await this.questionModel
      .find({ activity_id: activity._id })
      .sort({ order: 1, created_at: 1 })
      .lean()
      .exec();
    // Las preguntas anteriores a los tipos no tienen `type`
    return questions.map((q) => ({ ...q, type: q.type || 'open' }));
  }

  /** { [activityId]: { total, enabled } } para los badges del listado. */
  async countsByEvent(organizationId: string, eventId: string) {
    const event = await this.findEvent(eventId);
    this.assertOrg(event, organizationId);
    const rows = await this.questionModel
      .aggregate<{ _id: Types.ObjectId; total: number; enabled: number }>([
        { $match: { event_id: event._id } },
        {
          $group: {
            _id: '$activity_id',
            total: { $sum: 1 },
            enabled: { $sum: { $cond: ['$enabled', 1, 0] } },
          },
        },
      ])
      .exec();
    return Object.fromEntries(
      rows.map((r) => [String(r._id), { total: r.total, enabled: r.enabled }]),
    );
  }

  // ─── Generación con IA ─────────────────────────────────────────────────

  async generate(
    organizationId: string,
    activityId: string,
    body: GenerateQuestionsBody,
    uid: string,
  ) {
    const { activity, event } = await this.findActivityInOrg(
      organizationId,
      activityId,
    );

    const num = Math.round(Number(body.num_questions ?? DEFAULT_NUM_QUESTIONS));
    if (!Number.isFinite(num) || num < 1 || num > MAX_NUM_QUESTIONS) {
      throw new BadRequestException(
        `num_questions debe estar entre 1 y ${MAX_NUM_QUESTIONS}`,
      );
    }
    const difficulty = body.difficulty || 'mixed';
    if (difficulty !== 'mixed' && !DIFFICULTIES.includes(difficulty)) {
      throw new BadRequestException('Dificultad inválida');
    }
    const mode = body.mode === 'append' ? 'append' : 'replace';
    const types =
      Array.isArray(body.types) && body.types.length
        ? [...new Set(body.types)]
        : [...QUESTION_TYPES];
    const invalidType = types.find((t) => !QUESTION_TYPES.includes(t));
    if (invalidType) {
      throw new BadRequestException(
        `Tipo de pregunta inválido: ${invalidType}`,
      );
    }

    const key = String(activity._id);
    if (this.generating.has(key)) {
      throw new ConflictException(
        'Ya se están generando preguntas para esta actividad',
      );
    }
    this.generating.add(key);
    try {
      const material = await this.buildMaterial(event, activity);
      if (material.text.length < MIN_CONTENT_CHARS || !material.hasTranscript) {
        throw new BadRequestException(
          material.hasTranscript
            ? 'La actividad no tiene contenido suficiente para generar preguntas'
            : 'La actividad aún no tiene transcripción. Genera el transcript del video primero.',
        );
      }

      // Al agregar, se le pasan las existentes a la IA para no repetirlas;
      // al reemplazar, solo las que se conservan (manuales o editadas).
      const kept = await this.questionModel
        .find(
          mode === 'append'
            ? { activity_id: activity._id }
            : {
                activity_id: activity._id,
                $or: [{ source: 'manual' }, { edited: true }],
              },
        )
        .select('question order')
        .lean()
        .exec();

      const generated = await this.callModel(
        event,
        activity,
        material,
        num,
        types,
        difficulty,
        String(body.instructions || '').trim(),
        kept.map((q) => q.question),
      );
      if (!generated.length) {
        throw new BadRequestException(
          'La IA no devolvió preguntas válidas. Inténtalo de nuevo.',
        );
      }

      if (mode === 'replace') {
        await this.questionModel
          .deleteMany({
            activity_id: activity._id,
            source: 'ai',
            edited: { $ne: true },
          })
          .exec();
      }

      const user = await this.usersService.findByFirebaseUid(uid);
      const startOrder = kept.reduce(
        (max, q) => Math.max(max, q.order || 0),
        0,
      );
      await this.questionModel.insertMany(
        generated.map((q, i) => ({
          ...q,
          activity_id: activity._id,
          event_id: event._id,
          module_id: activity.module_id ? String(activity.module_id) : null,
          organization_id: event.organizer_id,
          source: 'ai',
          edited: false,
          enabled: true,
          order: startOrder + i + 1,
          updated_by: user._id,
        })),
      );

      return {
        generated: generated.length,
        transcript_chars: material.transcriptChars,
        truncated: material.truncated,
        questions: await this.list(organizationId, activityId),
      };
    } finally {
      this.generating.delete(key);
    }
  }

  /**
   * Material de referencia de la actividad: curso, módulo, actividad,
   * transcript completo (en bloques de ~1 min con [m:ss]) y documentos.
   */
  private async buildMaterial(
    event: Event,
    activity: Activity,
  ): Promise<ActivityMaterial> {
    const parts = [`CURSO: ${event.name}`];
    if (event.description) {
      parts.push(
        `DESCRIPCIÓN DEL CURSO: ${stripHtml(event.description).slice(0, 3000)}`,
      );
    }
    if (activity.module_id && Types.ObjectId.isValid(activity.module_id)) {
      const mod = await this.moduleModel
        .findById(activity.module_id)
        .select('module_name')
        .lean()
        .exec();
      if (mod?.module_name) parts.push(`MÓDULO: ${mod.module_name}`);
    }
    parts.push(`ACTIVIDAD: ${activity.name}`);
    const desc = activity.description || activity.short_description;
    if (desc) {
      parts.push(
        `DESCRIPCIÓN DE LA ACTIVIDAD: ${stripHtml(desc).slice(0, 3000)}`,
      );
    }

    // Transcript: segmentos con tiempos si existen; si no, texto consolidado
    const segments = await this.segmentModel
      .find({ activity_id: { $in: idVariants(activity._id) } })
      .select('startTime text')
      .sort({ startTime: 1 })
      .lean()
      .exec();

    let transcript = '';
    let timestamped = false;
    if (segments.length) {
      timestamped = true;
      const blocks: string[] = [];
      let blockStart = -Infinity;
      let current: string[] = [];
      for (const seg of segments) {
        const text = (seg.text || '').trim();
        if (!text) continue;
        if (seg.startTime - blockStart >= BLOCK_SECONDS) {
          if (current.length) blocks.push(current.join(' '));
          blockStart = seg.startTime;
          current = [`[${formatTime(seg.startTime)}]`];
        }
        current.push(text);
      }
      if (current.length) blocks.push(current.join(' '));
      transcript = blocks.join('\n');
    } else if (activity.textTranscription) {
      transcript = activity.textTranscription.trim();
    }

    const transcriptChars = transcript.length;
    const truncated = transcriptChars > MAX_TRANSCRIPT_CHARS;
    if (truncated) {
      this.logger.warn(
        `Transcript de la actividad ${activity._id} recortado: ${transcriptChars} > ${MAX_TRANSCRIPT_CHARS} caracteres`,
      );
      transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS);
    }
    if (transcript) {
      parts.push(
        `TRANSCRIPCIÓN DEL VIDEO${timestamped ? ' (cada línea inicia con el minuto del video)' : ''}:\n${transcript}`,
      );
    }

    // Documentos subidos a la actividad
    const docs = await this.documentModel
      .find({ activityId: { $in: idVariants(activity._id) }, active: true })
      .select('name content')
      .lean()
      .exec();
    let docsBudget = MAX_DOCUMENTS_CHARS;
    for (const doc of docs) {
      if (!doc.content || docsBudget <= 0) continue;
      const content = doc.content.slice(0, docsBudget);
      docsBudget -= content.length;
      parts.push(`DOCUMENTO DE APOYO "${doc.name}":\n${content}`);
    }

    return {
      text: parts.join('\n\n'),
      hasTranscript: Boolean(transcript),
      timestamped,
      transcriptChars,
      truncated,
    };
  }

  private async callModel(
    event: Event,
    activity: Activity,
    material: ActivityMaterial,
    num: number,
    types: ActivityQuestionType[],
    difficulty: string,
    instructions: string,
    existing: string[],
  ) {
    const language = event.language === 'en' ? 'inglés' : 'español';
    const counts = distributeTypes(num, types);
    const plan = Object.entries(counts)
      .map(([t, n]) => `- ${n} de tipo "${t}" (${TYPE_LABELS[t]})`)
      .join('\n');
    const extra: string[] = [];
    if (instructions) extra.push(`Indicaciones del docente: ${instructions}`);
    if (existing.length) {
      extra.push(
        'Ya existen estas preguntas; NO las repitas ni preguntes lo mismo con otras palabras:\n' +
          existing.map((q) => `- ${q}`).join('\n'),
      );
    }

    const prompt = `Genera exactamente ${num} preguntas en ${language} sobre la actividad "${activity.name}", con sus respuestas, repartidas así:
${plan}

Reglas generales:
- Basa las preguntas en lo que se enseña en la TRANSCRIPCIÓN DEL VIDEO (y los documentos de apoyo, si hay). Usa la información del curso y del módulo solo como contexto.
- Distribuye las preguntas a lo largo de TODO el video (inicio, mitad y final) y cubre temas distintos; no repitas ideas.
- Ignora saludos, logística, anuncios y comentarios que no sean contenido académico.
- ${DIFFICULTY_HINT[difficulty] || DIFFICULTY_HINT.mixed}
- No menciones "la transcripción", "el video" ni minutos en el enunciado; pregunta por los conceptos.
- Toda respuesta correcta debe ser fiel a lo explicado en la clase, sin ambigüedad.

Reglas por tipo:
${types.map((t) => `- ${TYPE_RULES[t]}`).join('\n')}

Campos comunes a todas:
- "type": uno de los tipos de arriba.
- "explanation": 1 a 3 frases que expliquen por qué la respuesta es correcta, según la clase.
- "difficulty": "basic", "intermediate" o "advanced".
- "topic": tema en 2 a 6 palabras.
- "start_time": ${material.timestamped ? 'la marca [m:ss] o [h:mm:ss] del bloque donde se explica el tema, copiada tal cual (ej. "12:30")' : 'null'}.
- Omite los campos que no apliquen al tipo.
${extra.length ? '\n' + extra.join('\n\n') + '\n' : ''}
Responde SOLO con un arreglo JSON. Ejemplos de cada tipo:
[{"type": "open", "question": "...", "answer": "...", "key_points": ["..."], "explanation": "...", "difficulty": "intermediate", "topic": "...", "start_time": "3:10"},
 {"type": "single_choice", "question": "...", "options": [{"text": "...", "correct": true}, {"text": "...", "correct": false}, {"text": "...", "correct": false}, {"text": "...", "correct": false}], "explanation": "...", "difficulty": "basic", "topic": "...", "start_time": "12:30"},
 {"type": "multiple_choice", "question": "... (selecciona todas las correctas)", "options": [{"text": "...", "correct": true}, {"text": "...", "correct": true}, {"text": "...", "correct": false}, {"text": "...", "correct": false}, {"text": "...", "correct": false}], "explanation": "...", "difficulty": "intermediate", "topic": "...", "start_time": "15:45"},
 {"type": "true_false", "question": "...", "answer": false, "explanation": "...", "difficulty": "basic", "topic": "...", "start_time": "20:05"},
 {"type": "fill_blank", "question": "El ... se llama ${BLANK}.", "answer": "...", "accepted_answers": ["..."], "explanation": "...", "difficulty": "basic", "topic": "...", "start_time": "25:40"},
 {"type": "ordering", "question": "Ordena ...", "options": [{"text": "primer paso"}, {"text": "segundo paso"}, {"text": "tercer paso"}], "explanation": "...", "difficulty": "intermediate", "topic": "...", "start_time": "41:00"},
 {"type": "matching", "question": "Relaciona ...", "pairs": [{"left": "...", "right": "..."}, {"left": "...", "right": "..."}, {"left": "...", "right": "..."}], "explanation": "...", "difficulty": "intermediate", "topic": "...", "start_time": "55:20"}]

MATERIAL:
${material.text}`;

    const raw = await this.gemini.generateJson<Record<string, any>[]>(
      'Eres un diseñador instruccional experto en evaluación. Creas preguntas de distintos tipos con sus respuestas a partir del contenido real de una clase. Usa EXCLUSIVAMENTE el material entregado; no inventes temas ni datos.',
      prompt,
      0.4,
      GENERATION_TIMEOUT_MS,
    );

    const valid: (ReturnType<typeof normalizeQuestion> & {
      difficulty: ActivityQuestionDifficulty;
      topic: string;
      start_time: number | null;
    })[] = [];
    let discarded = 0;
    for (const q of Array.isArray(raw) ? raw : []) {
      if (valid.length >= num) break;
      try {
        const content = normalizeQuestion(q, {
          language: event.language,
          shuffleOptions: true,
          fixTypes: true,
        });
        if (!types.includes(content.type)) {
          throw new InvalidQuestionError(
            `tipo no solicitado (${content.type})`,
          );
        }
        valid.push({
          ...content,
          difficulty: DIFFICULTIES.includes(q.difficulty)
            ? q.difficulty
            : 'intermediate',
          topic: String(q.topic || '').trim(),
          start_time: material.timestamped ? parseTime(q.start_time) : null,
        });
      } catch (error) {
        discarded++;
        this.logger.warn(
          `Pregunta descartada (${q?.type}): ${(error as Error).message}`,
        );
      }
    }
    if (discarded) {
      this.logger.warn(
        `Actividad ${activity._id}: ${discarded} preguntas inválidas descartadas`,
      );
    }
    return valid;
  }

  // ─── CRUD manual ───────────────────────────────────────────────────────

  async create(
    organizationId: string,
    activityId: string,
    body: QuestionInput,
    uid: string,
  ) {
    const { activity, event } = await this.findActivityInOrg(
      organizationId,
      activityId,
    );
    const fields = {
      ...this.sanitizeMeta(body),
      ...this.validateContent({ ...body, type: body.type || 'open' }, event),
    };
    const user = await this.usersService.findByFirebaseUid(uid);
    const last = await this.questionModel
      .findOne({ activity_id: activity._id })
      .sort({ order: -1 })
      .select('order')
      .lean()
      .exec();
    const created = await this.questionModel.create({
      order: (last?.order || 0) + 1,
      ...fields,
      activity_id: activity._id,
      event_id: event._id,
      module_id: activity.module_id ? String(activity.module_id) : null,
      organization_id: event.organizer_id,
      source: 'manual',
      updated_by: user._id,
    });
    return created.toObject();
  }

  async update(
    organizationId: string,
    activityId: string,
    questionId: string,
    body: QuestionInput,
    uid: string,
  ) {
    const { activity, event } = await this.findActivityInOrg(
      organizationId,
      activityId,
    );
    const filter = {
      _id: this.objectId(questionId),
      activity_id: activity._id,
    };
    const current = await this.questionModel.findOne(filter).lean().exec();
    if (!current) throw new NotFoundException('Pregunta no encontrada');

    const fields: Record<string, any> = this.sanitizeMeta(body);
    // Si cambia el contenido se valida la pregunta completa (actual + cambios).
    // Cambiar solo enabled/order no cuenta como edición.
    const input = body as Record<string, unknown>;
    const contentChanged = CONTENT_FIELDS.some((k) => input[k] !== undefined);
    if (contentChanged) {
      const merged: Record<string, any> = { type: current.type || 'open' };
      for (const k of CONTENT_FIELDS) {
        if (current[k] !== undefined) merged[k] = current[k];
        if (input[k] !== undefined) merged[k] = input[k];
      }
      Object.assign(fields, this.validateContent(merged, event));
    }
    const user = await this.usersService.findByFirebaseUid(uid);
    const updated = await this.questionModel
      .findOneAndUpdate(
        filter,
        {
          $set: {
            ...fields,
            ...(contentChanged || body.topic !== undefined
              ? { edited: true }
              : {}),
            updated_by: user._id,
          },
        },
        { new: true },
      )
      .lean()
      .exec();
    if (!updated) throw new NotFoundException('Pregunta no encontrada');
    return updated;
  }

  async remove(organizationId: string, activityId: string, questionId: string) {
    const { activity } = await this.findActivityInOrg(
      organizationId,
      activityId,
    );
    const res = await this.questionModel
      .deleteOne({ _id: this.objectId(questionId), activity_id: activity._id })
      .exec();
    if (!res.deletedCount)
      throw new NotFoundException('Pregunta no encontrada');
    return { deleted: true };
  }

  async removeAll(organizationId: string, activityId: string) {
    const { activity } = await this.findActivityInOrg(
      organizationId,
      activityId,
    );
    const res = await this.questionModel
      .deleteMany({ activity_id: activity._id })
      .exec();
    return { deleted: res.deletedCount };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /** Campos que no dependen del tipo de pregunta. */
  private sanitizeMeta(body: QuestionInput) {
    const out: Record<string, any> = {};
    if (body.topic !== undefined) out.topic = String(body.topic).trim();
    if (body.difficulty !== undefined) {
      if (!DIFFICULTIES.includes(body.difficulty)) {
        throw new BadRequestException('Dificultad inválida');
      }
      out.difficulty = body.difficulty;
    }
    if (body.start_time !== undefined) {
      out.start_time =
        body.start_time === null ? null : parseTime(body.start_time);
    }
    if (body.enabled !== undefined) out.enabled = Boolean(body.enabled);
    if (body.order !== undefined && Number.isFinite(Number(body.order))) {
      out.order = Number(body.order);
    }
    return out;
  }

  /** Valida el contenido según el tipo; los errores salen como 400. */
  private validateContent(input: Record<string, any>, event: Event) {
    try {
      return normalizeQuestion(input, { language: event.language });
    } catch (error) {
      if (error instanceof InvalidQuestionError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private objectId(id: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Recurso no encontrado');
    }
    return new Types.ObjectId(id);
  }

  private async findEvent(eventId: string): Promise<Event> {
    const event = await this.eventModel.findById(this.objectId(eventId)).exec();
    if (!event) throw new NotFoundException('Curso no encontrado');
    return event;
  }

  private assertOrg(event: Event, organizationId: string) {
    if (String(event.organizer_id) !== String(organizationId)) {
      throw new NotFoundException('Curso no encontrado en esta organización');
    }
  }

  private async findActivityInOrg(organizationId: string, activityId: string) {
    const activity = await this.activityModel
      .findById(this.objectId(activityId))
      .exec();
    if (!activity) throw new NotFoundException('Actividad no encontrada');
    const event = await this.findEvent(String(activity.event_id));
    this.assertOrg(event, organizationId);
    return { activity, event };
  }
}
