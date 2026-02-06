import { IsNotEmpty, IsString } from 'class-validator';

export class UpsertQuizDto {
  @IsString()
  @IsNotEmpty()
  eventId: string;

  @IsNotEmpty()
  questions: any; // puede ser array
}
