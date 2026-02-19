import { Type, Transform } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsArray,
  ValidateNested,
  IsUUID,
  IsEnum,
  IsNumber,
  IsOptional,
  ArrayMinSize,
} from 'class-validator';

// ============= Content Block DTOs =============
export class TextBlockDto {
  @IsEnum(['text'])
  type: 'text';

  @IsString()
  @IsNotEmpty()
  id: string;

  @IsString()
  @IsNotEmpty()
  content: string;

  @IsEnum(['plain', 'h1', 'h2', 'h3', 'quote', 'code'])
  format: string;

  @IsEnum(['none', 'bullet', 'ordered'])
  listType: string;
}

export class ImageBlockDto {
  @IsEnum(['image'])
  type: 'image';

  @IsString()
  @IsNotEmpty()
  id: string;

  @IsString()
  @IsNotEmpty()
  url: string;

  @IsString()
  @IsOptional()
  caption?: string;
}

export class VideoBlockDto {
  @IsEnum(['video'])
  type: 'video';

  @IsString()
  @IsNotEmpty()
  id: string;

  @IsString()
  @IsNotEmpty()
  url: string;

  @IsString()
  @IsOptional()
  caption?: string;
}

export type ContentBlockDto = TextBlockDto | ImageBlockDto | VideoBlockDto;

// ============= Single Choice DTO =============
export class SingleChoiceOptionDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TextBlockDto, {
    discriminator: {
      property: 'type',
      subTypes: [
        { value: TextBlockDto, name: 'text' },
        { value: ImageBlockDto, name: 'image' },
        { value: VideoBlockDto, name: 'video' },
      ],
    },
  })
  blocks: ContentBlockDto[];
}

export class SingleChoiceQuestionDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsEnum(['single-choice'])
  type: 'single-choice';

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TextBlockDto, {
    discriminator: {
      property: 'type',
      subTypes: [
        { value: TextBlockDto, name: 'text' },
        { value: ImageBlockDto, name: 'image' },
        { value: VideoBlockDto, name: 'video' },
      ],
    },
  })
  blocks: ContentBlockDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SingleChoiceOptionDto)
  opciones: SingleChoiceOptionDto[];

  @IsNumber()
  @IsNotEmpty()
  respuestacorrecta: number;
}

// ============= Multiple Choice DTO =============
export class MultipleChoiceQuestionDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsEnum(['multiple-choice'])
  type: 'multiple-choice';

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TextBlockDto, {
    discriminator: {
      property: 'type',
      subTypes: [
        { value: TextBlockDto, name: 'text' },
        { value: ImageBlockDto, name: 'image' },
        { value: VideoBlockDto, name: 'video' },
      ],
    },
  })
  blocks: ContentBlockDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SingleChoiceOptionDto)
  opciones: SingleChoiceOptionDto[];

  @IsArray()
  @ArrayMinSize(1)
  respuestascorrectas: number[];
}

// ============= Matching DTO =============
export class MatchingPairDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TextBlockDto, {
    discriminator: {
      property: 'type',
      subTypes: [
        { value: TextBlockDto, name: 'text' },
        { value: ImageBlockDto, name: 'image' },
        { value: VideoBlockDto, name: 'video' },
      ],
    },
  })
  leftBlocks: ContentBlockDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TextBlockDto, {
    discriminator: {
      property: 'type',
      subTypes: [
        { value: TextBlockDto, name: 'text' },
        { value: ImageBlockDto, name: 'image' },
        { value: VideoBlockDto, name: 'video' },
      ],
    },
  })
  rightBlocks: ContentBlockDto[];
}

export class MatchingQuestionDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsEnum(['matching'])
  type: 'matching';

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TextBlockDto, {
    discriminator: {
      property: 'type',
      subTypes: [
        { value: TextBlockDto, name: 'text' },
        { value: ImageBlockDto, name: 'image' },
        { value: VideoBlockDto, name: 'video' },
      ],
    },
  })
  blocks: ContentBlockDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MatchingPairDto)
  pairs: MatchingPairDto[];
}

// ============= Ordering DTO =============
export class OrderingItemDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TextBlockDto, {
    discriminator: {
      property: 'type',
      subTypes: [
        { value: TextBlockDto, name: 'text' },
        { value: ImageBlockDto, name: 'image' },
        { value: VideoBlockDto, name: 'video' },
      ],
    },
  })
  blocks: ContentBlockDto[];
}

export class OrderingQuestionDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsEnum(['ordering'])
  type: 'ordering';

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TextBlockDto, {
    discriminator: {
      property: 'type',
      subTypes: [
        { value: TextBlockDto, name: 'text' },
        { value: ImageBlockDto, name: 'image' },
        { value: VideoBlockDto, name: 'video' },
      ],
    },
  })
  blocks: ContentBlockDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderingItemDto)
  items: OrderingItemDto[];

  @IsArray()
  @ArrayMinSize(1)
  correctOrder: string[];
}

// Union type
export type QuestionDto =
  | SingleChoiceQuestionDto
  | MultipleChoiceQuestionDto
  | MatchingQuestionDto
  | OrderingQuestionDto;
