import { IsNotEmpty, IsString } from 'class-validator';

export class SubmitQuizDto {
  @IsString()
  @IsNotEmpty()
  userId: string;
}
