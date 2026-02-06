import { IsNotEmpty, IsNumber, IsString, Max, Min } from 'class-validator';

export class SubmitQuizDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsNumber()
  @Min(0)
  @Max(5) // ajusta si tu nota es otra escala
  result: number;
}
