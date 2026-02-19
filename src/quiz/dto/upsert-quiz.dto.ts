import { IsNotEmpty, IsString, IsArray, ValidateNested, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';
import {
  SingleChoiceQuestionDto,
  MultipleChoiceQuestionDto,
  MatchingQuestionDto,
  OrderingQuestionDto,
} from './question.dto';

export class UpsertQuizDto {
  @IsString()
  @IsNotEmpty()
  eventId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => Object, {
    discriminator: {
      property: 'type',
      subTypes: [
        { value: SingleChoiceQuestionDto, name: 'single-choice' },
        { value: MultipleChoiceQuestionDto, name: 'multiple-choice' },
        { value: MatchingQuestionDto, name: 'matching' },
        { value: OrderingQuestionDto, name: 'ordering' },
      ],
    },
  })
  questions: (
    | SingleChoiceQuestionDto
    | MultipleChoiceQuestionDto
    | MatchingQuestionDto
    | OrderingQuestionDto
  )[];
}
