import { Controller, Post, Body } from '@nestjs/common';
import { QuestionnaireService } from './questionnaire.service';

@Controller('questionnaire')
export class QuestionnaireController {
  constructor(private readonly questionnaireService: QuestionnaireService) {}

  /**
   * Recibe una transcripción y retorna el cuestionario generado por Hugging Face.
   *
   * @param transcript Texto transcrito que envía el frontend
   * @returns Preguntas generadas en formato JSON o un string con las preguntas
   */
  @Post()
  async generateQuestions(@Body('transcript') transcript: string) {
    // transcript será el texto que el usuario envíe desde el frontend
    const questions =
      await this.questionnaireService.getQuestionnaire(transcript);
    return questions;
  }
}
