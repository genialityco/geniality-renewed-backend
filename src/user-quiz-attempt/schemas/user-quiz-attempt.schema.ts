import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// ─────────────────────────────────────────────
// UserAnswer (respuesta del usuario a una pregunta)
// ─────────────────────────────────────────────

@Schema({ _id: false })
export class UserAnswer {
  @Prop({ required: true })
  questionId: string;

  /**
   * La respuesta del usuario. Puede ser:
   * - string         → para single (id de opción)
   * - string[]       → para multiple (ids de opciones) o sorting (orden de ids)
   * - MatchingAnswer → para matching ({ columnAId, matches: { B: id, … } })
   * - string (texto) → para open (respuesta de texto abierto)
   */
  @Prop({ type: Object, default: null })
  answer: any;
}
export const UserAnswerSchema = SchemaFactory.createForClass(UserAnswer);

// ─────────────────────────────────────────────
// ManualScore (calificación manual de pregunta abierta)
// ─────────────────────────────────────────────

@Schema({ _id: false })
export class ManualScore {
  @Prop({ required: true })
  questionId: string;

  /** Calificación del admin (1-10) */
  @Prop({ required: true, min: 1, max: 10 })
  score: number;

  /** Fecha de calificación */
  @Prop({ required: true, default: () => new Date() })
  gradedAt: Date;

  /** ID del admin que calificó */
  @Prop({ default: null })
  gradedBy: string | null;
}
export const ManualScoreSchema = SchemaFactory.createForClass(ManualScore);

// ─────────────────────────────────────────────
// UserQuizAttempt (root document)
// ─────────────────────────────────────────────

export type UserQuizAttemptDocument = UserQuizAttempt & Document;

@Schema({ timestamps: true, collection: 'UserAttemptsQuiz' })
export class UserQuizAttempt {
  /** ID del quiz al que pertenece este intento */
  @Prop({ required: true, index: true })
  quizId: string;

  /** ID del usuario que realizó el intento */
  @Prop({ required: true, index: true })
  userId: string;

  /** Fecha y hora en que se realizó el intento */
  @Prop({ required: true })
  attemptedAt: Date;

  /**
   * Estado del intento:
   * - "graded"  → el examen ha sido calificado completamente.
   * - "pending" → el examen está pendiente de calificación.
   * - "review"  → el examen tiene preguntas abiertas en revisión (esperando calificación manual).
   */
  @Prop({ required: true, enum: ['graded', 'pending', 'review'], default: 'pending' })
  status: 'graded' | 'pending' | 'review';

  /** Puntaje obtenido (0–100). 0 mientras esté pendiente. */
  @Prop({ default: 0 })
  score: number;

  /** Respuestas del usuario por pregunta */
  @Prop({ type: [UserAnswerSchema], default: [] })
  userAnswers: UserAnswer[];

  /**
   * Calificaciones manuales de preguntas abiertas.
   * Se usa para almacenar las puntuaciones (1-10) asignadas por el admin.
   */
  @Prop({ type: [ManualScoreSchema], default: [] })
  manualScores: ManualScore[];
}

export const UserQuizAttemptSchema =
  SchemaFactory.createForClass(UserQuizAttempt);

// Índice compuesto para consultas frecuentes (quiz + usuario)
UserQuizAttemptSchema.index({ quizId: 1, userId: 1 });
