import { IsNotEmpty, IsNumber, IsString, Max, Min, IsOptional } from 'class-validator';

export class SaveQuizResultDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsNumber()
  @Min(0)
  @Max(5) // ajusta si tu nota es otra escala
  result: number;

  @IsOptional()
  answers?: any; // Array de respuestas - sin validar para evitar transformación
}
