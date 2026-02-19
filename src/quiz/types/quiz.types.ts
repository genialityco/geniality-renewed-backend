/**
 * Tipos para la estructura de preguntas con bloques de contenido
 */

// Bloques de contenido reutilizables
export type BlockFormat = 'plain' | 'h1' | 'h2' | 'h3' | 'quote' | 'code';
export type ListType = 'none' | 'bullet' | 'ordered';

export interface TextBlock {
  type: 'text';
  id: string;
  content: string;
  format: BlockFormat;
  listType: ListType;
}

export interface ImageBlock {
  type: 'image';
  id: string;
  url: string;
  caption?: string;
}

export interface VideoBlock {
  type: 'video';
  id: string;
  url: string;
  caption?: string;
}

export type ContentBlock = TextBlock | ImageBlock | VideoBlock;

// Base para todas las preguntas
export interface BaseQuestion {
  id: string;
  blocks: ContentBlock[];
}

// Preguntas de selección única
export interface SingleChoiceOption {
  id: string;
  blocks: ContentBlock[];
}

export interface SingleChoiceQuestion extends BaseQuestion {
  type: 'single-choice';
  opciones: SingleChoiceOption[];
  respuestacorrecta: number; // índice de la opción correcta
}

// Preguntas de selección múltiple
export interface MultipleChoiceQuestion extends BaseQuestion {
  type: 'multiple-choice';
  opciones: SingleChoiceOption[];
  respuestascorrectas: number[]; // índices de opciones correctas
}

// Preguntas de emparejamiento
export interface MatchingPair {
  id: string;
  leftBlocks: ContentBlock[];
  rightBlocks: ContentBlock[];
}

export interface MatchingQuestion extends BaseQuestion {
  type: 'matching';
  pairs: MatchingPair[];
}

// Preguntas de ordenamiento
export interface OrderingItem {
  id: string;
  blocks: ContentBlock[];
}

export interface OrderingQuestion extends BaseQuestion {
  type: 'ordering';
  items: OrderingItem[];
  correctOrder: string[]; // IDs en orden correcto
}

// Unión de todos los tipos de preguntas
export type Question =
  | SingleChoiceQuestion
  | MultipleChoiceQuestion
  | MatchingQuestion
  | OrderingQuestion;

// Estructura principal del quiz
export interface QuizStructure {
  eventId: string;
  questions: Question[];
}
