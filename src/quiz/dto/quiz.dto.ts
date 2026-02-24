import {
  IsString,
  IsArray,
  IsOptional,
  IsIn,
  ValidateNested,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';

// ─────────────────────────────────────────────
// EditorBlock DTO
// ─────────────────────────────────────────────

export class EditorBlockDto {
  @IsString()
  id: string;

  @IsString()
  @IsIn([
    'paragraph',
    'h1',
    'h2',
    'bullet-list',
    'numbered-list',
    'image',
    'video',
  ])
  type: string;

  @IsString()
  @IsOptional()
  content?: string;
}

// ─────────────────────────────────────────────
// Option DTO
// ─────────────────────────────────────────────

export class QuestionOptionDto {
  @IsString()
  id: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EditorBlockDto)
  blocks: EditorBlockDto[];
}

// ─────────────────────────────────────────────
// Matching DTOs
// ─────────────────────────────────────────────

export class MatchingColumnDto {
  @IsString()
  label: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuestionOptionDto)
  options: QuestionOptionDto[];
}

export class MatchingAnswerDto {
  @IsString()
  columnAId: string;

  @IsObject()
  matches: Record<string, string>;
}

// ─────────────────────────────────────────────
// Question DTO
// ─────────────────────────────────────────────

export class QuestionDto {
  @IsString()
  id: string;

  @IsString()
  @IsIn(['single', 'multiple', 'matching', 'sorting'])
  type: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EditorBlockDto)
  blocks: EditorBlockDto[];

  // single / multiple
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => QuestionOptionDto)
  options?: QuestionOptionDto[];

  @IsString()
  @IsOptional()
  correctAnswer?: string | null;

  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  correctAnswers?: string[];

  // matching
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => MatchingColumnDto)
  columns?: MatchingColumnDto[];

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => MatchingAnswerDto)
  matchingAnswers?: MatchingAnswerDto[];

  // sorting
  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  correctOrder?: string[];
}

// ─────────────────────────────────────────────
// Quiz DTOs
// ─────────────────────────────────────────────

export class CreateQuizDto {
  @IsString()
  eventId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuestionDto)
  questions: QuestionDto[];
}

export class UpdateQuizDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuestionDto)
  questions: QuestionDto[];
}

// ─────────────────────────────────────────────
// User Answer DTOs
// ─────────────────────────────────────────────

export class UserAnswerDto {
  @IsString()
  questionId: string;

  @IsOptional()
  @IsObject()
  answer: any; // puede ser string, string[], o un objeto para matching
}

export class SubmitQuizAttempDto {
  @IsString()
  userId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UserAnswerDto)
  userAnswers: UserAnswerDto[];

  @IsOptional()
  score?: number; // opcional si se calcula en el backend
}
