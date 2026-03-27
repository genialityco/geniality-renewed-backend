import {
  IsString,
  IsArray,
  IsOptional,
  IsObject,
  IsNumber,
  IsBoolean,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// ─────────────────────────────────────────────
// UserAnswer DTO
// ─────────────────────────────────────────────

export class UserAnswerDto {
  @IsString()
  questionId: string;

  @IsOptional()
  @IsObject()
  answer: any; // string | string[] | { columnAId, matches } para matching
}

// ─────────────────────────────────────────────
// Submit attempt DTO
// ─────────────────────────────────────────────

export class SubmitAttemptDto {
  @IsString()
  userId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UserAnswerDto)
  userAnswers: UserAnswerDto[];

  @IsOptional()
  @IsBoolean()
  hasOpenQuestions?: boolean; // true si el quiz tiene preguntas abiertas
}

// ─────────────────────────────────────────────
// Grade attempt DTO  (calificación manual)
// ─────────────────────────────────────────────

export class GradeAttemptDto {
  @IsNumber()
  @Min(0)
  @Max(100)
  score: number;
}

// ─────────────────────────────────────────────
// Grade open question DTO (calificar pregunta abierta)
// ─────────────────────────────────────────────

export class GradeOpenQuestionDto {
  @IsString()
  questionId: string;

  @IsNumber()
  @Min(1)
  @Max(10)
  score: number; // Calificación 1-10 del admin

  @IsOptional()
  @IsString()
  gradedBy?: string; // ID del admin que califica (opcional)
}
