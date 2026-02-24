import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { v4 as randomUUID } from 'uuid';

// ─────────────────────────────────────────────
// Sub-schemas
// ─────────────────────────────────────────────

/**
 * A single block from the Notion-like editor.
 * content is ALWAYS a clean string:
 *   - text blocks  → plain text
 *   - image blocks → Firebase Storage URL or any https:// URL
 *   - video blocks → Firebase Storage URL, YouTube URL, or Vimeo URL
 */
@Schema({ _id: false })
export class EditorBlock {
  @Prop({ required: true })
  id: string;

  @Prop({
    required: true,
    enum: [
      'paragraph',
      'h1',
      'h2',
      'bullet-list',
      'numbered-list',
      'image',
      'video',
    ],
  })
  type: string;

  @Prop({ default: '' })
  content: string;
}
export const EditorBlockSchema = SchemaFactory.createForClass(EditorBlock);

// ── Option (used in single, multiple, sorting and matching columns) ──

@Schema({ _id: false })
export class QuestionOption {
  /** Client-generated UUID so the frontend can reference it in correctAnswer(s) */
  @Prop({ required: true })
  id: string;

  @Prop({ type: [EditorBlockSchema], default: [] })
  blocks: EditorBlock[];
}
export const QuestionOptionSchema =
  SchemaFactory.createForClass(QuestionOption);

// ── Matching column ──

@Schema({ _id: false })
export class MatchingColumn {
  /** e.g. "A", "B", "C" — or any label */
  @Prop({ required: true })
  label: string;

  @Prop({ type: [QuestionOptionSchema], default: [] })
  options: QuestionOption[];
}
export const MatchingColumnSchema =
  SchemaFactory.createForClass(MatchingColumn);

/**
 * One row in the correctAnswers of a Matching question.
 * Always anchored to column A (index 0).
 *
 * Example with 3 columns:
 * { columnAId: "a1", matches: { B: "b3", C: "c2" } }
 */
@Schema({ _id: false })
export class MatchingAnswer {
  @Prop({ required: true })
  columnAId: string;

  /**
   * Key = column label (B, C, D…), Value = selected option id from that column.
   * Using Mixed because the keys are dynamic (depend on how many columns exist).
   */
  @Prop({ type: Object, default: {} })
  matches: Record<string, string>;
}
export const MatchingAnswerSchema =
  SchemaFactory.createForClass(MatchingAnswer);

// ─────────────────────────────────────────────
// Question
// ─────────────────────────────────────────────

export type QuestionType = 'single' | 'multiple' | 'matching' | 'sorting';

@Schema({ _id: false })
export class Question {
  @Prop({ required: true })
  id: string;

  @Prop({ required: true, enum: ['single', 'multiple', 'matching', 'sorting'] })
  type: QuestionType;

  /** The question statement — rendered by the Notion-like editor */
  @Prop({ type: [EditorBlockSchema], default: [] })
  blocks: EditorBlock[];

  // ── single / multiple ──
  @Prop({ type: [QuestionOptionSchema], default: [] })
  options: QuestionOption[];

  /** single   → one option id   */
  @Prop({ default: null })
  correctAnswer: string | null;

  /** multiple → array of option ids */
  @Prop({ type: [String], default: [] })
  correctAnswers: string[];

  // ── matching ──
  /**
   * Dynamic columns. Column at index 0 is always "column A" and defines
   * the number of correctAnswers rows.
   * Columns B, C… can have more options than column A (repetition allowed).
   */
  @Prop({ type: [MatchingColumnSchema], default: [] })
  columns: MatchingColumn[];

  /** One entry per option in column A */
  @Prop({ type: [MatchingAnswerSchema], default: [] })
  matchingAnswers: MatchingAnswer[];

  // ── sorting ──
  /** Ordered list of option ids representing the correct sequence */
  @Prop({ type: [String], default: [] })
  correctOrder: string[];
}
export const QuestionSchema = SchemaFactory.createForClass(Question);

// ─────────────────────────────────────────────
// QuizConfig
// ─────────────────────────────────────────────

@Schema({ _id: false })
export class QuizConfig {
  /** Duración máxima en minutos. null = sin límite de tiempo. */
  @Prop({ type: Number, default: null })
  time: number | null;

  /** Número máximo de intentos permitidos. null = intentos ilimitados. */
  @Prop({ type: Number, default: null })
  attempts: number | null;

  /** Nota mínima en % para aprobar el examen. null = sin nota mínima. */
  @Prop({ type: Number, default: null })
  nota: number | null;

  /**
   * Modo de visualización de preguntas:
   * - "all"        → todas las preguntas en la misma página (default).
   * - "one-by-one" → una pregunta a la vez, sin posibilidad de retroceder.
   */
  @Prop({ type: String, enum: ['all', 'one-by-one'], default: 'all' })
  questionDisplay: 'all' | 'one-by-one';
}
export const QuizConfigSchema = SchemaFactory.createForClass(QuizConfig);

// ─────────────────────────────────────────────
// UserAnswer (respuesta del usuario a una pregunta)
// ─────────────────────────────────────────────

@Schema({ _id: false })
export class UserAnswer {
  @Prop({ required: true })
  questionId: string;

  /**
   * La respuesta del usuario. Pode ser:
   * - string: para single (id de opción)
   * - string[]: para multiple (ids de opciones)
   * - MatchingAnswer: para matching
   * - string[]: para sorting (orden de ids)
   */
  @Prop({ type: Object, default: null })
  answer: any;
}
export const UserAnswerSchema = SchemaFactory.createForClass(UserAnswer);

// ─────────────────────────────────────────────
// UserAttempt  (stored inside the quiz for quick access)
// ─────────────────────────────────────────────

@Schema({ _id: false })
export class UserAttempt {
  @Prop({ required: true })
  userId: string;

  @Prop({ required: true })
  attemptedAt: Date;

  /** Score as a percentage 0–100 */
  @Prop({ default: 0 })
  score: number;

  /** Array de respuestas del usuario por pregunta */
  @Prop({ type: [UserAnswerSchema], default: [] })
  userAnswers: UserAnswer[];
}
export const UserAttemptSchema = SchemaFactory.createForClass(UserAttempt);

// ─────────────────────────────────────────────
// Quiz (root document)
// ─────────────────────────────────────────────

export type QuizDocument = Quiz & Document;

@Schema({ timestamps: true })
export class Quiz {
  @Prop({ type: String, unique: true, sparse: true, default: () => randomUUID() })
  id: string;

  @Prop({ type: Types.ObjectId, ref: 'Event', required: true, index: true })
  eventId: Types.ObjectId;

  @Prop({ type: [QuestionSchema], default: [] })
  questions: Question[];

  @Prop({ type: [UserAttemptSchema], default: [] })
  listUserAttempts: UserAttempt[];

  @Prop({ type: QuizConfigSchema, default: () => ({}) })
  config: QuizConfig;
}

export const QuizSchema = SchemaFactory.createForClass(Quiz);

// Ensure only one quiz per event (sparse para ignorar nulls)
QuizSchema.index({ eventId: 1 }, { unique: true, sparse: true });
