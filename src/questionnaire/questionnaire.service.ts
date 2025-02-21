import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class QuestionnaireService {
  private readonly HUGGINGFACE_API_KEY = process.env.HF_API_KEY ?? '';

  private readonly HF_CHAT_URL =
    'https://api-inference.huggingface.co/models/google/gemma-2-2b-it';

  private readonly HEADERS = {
    Authorization: 'Bearer ' + this.HUGGINGFACE_API_KEY,
    'Content-Type': 'application/json',
  };

  /**
   * Envía la petición a Hugging Face para generar el cuestionario.
   * @param transcript Texto a partir del cual se generarán preguntas.
   * @returns Devuelve un array de todas las preguntas parseadas desde los bloques JSON.
   */
  async getQuestionnaire(transcript: string): Promise<any> {
    // Ajusta el prompt para que no incluya un bloque de ejemplo,
    // sino solo las 5 preguntas generadas en un único bloque JSON:
    const prompt = `
A partir del siguiente texto:

${transcript}

Genera exactamente 5 preguntas de selección única en formato JSON. Cada pregunta debe tener:
- "pregunta": el enunciado de la pregunta
- "opciones": un array de 4 respuestas (3 falsas y 1 verdadera)
- "respuestacorrecta": índice (0, 1, 2 o 3) correspondiente a la respuesta correcta dentro del array "opciones"

Devuélveme únicamente el bloque JSON, sin ningún texto adicional antes o después. 
El JSON debe ser un array con 5 objetos, y cada objeto con la estructura solicitada:
- pregunta
- opciones
- respuestacorrecta

No incluyas comas colgantes al final de los arrays u objetos.
No incluyas texto adicional ni ejemplos, solamente las preguntas generadas.
    `;

    const payload = {
      inputs: prompt,
    };

    try {
      const response = await axios.post(this.HF_CHAT_URL, payload, {
        headers: this.HEADERS,
      });

      // El texto que genera la IA suele estar en response.data[0].generated_text
      const aiMessage = response.data[0].generated_text;
      console.log(aiMessage);

      // Llamamos a la función auxiliar para extraer y parsear el bloque(s) JSON
      const questions = this.extractAllQuestions(aiMessage);

      return questions; // retorna un array con todas las preguntas
    } catch (error) {
      console.error(
        'Error fetching AI response:',
        error.response?.data || error.message,
      );
      throw new Error('Error generating questions');
    }
  }

  /**
   * Busca todas las secciones delimitadas por ```json ... ```
   * y acumula su contenido en un solo array.
   */
  private extractAllQuestions(aiMessage: string): any[] {
    const jsonRegex = /```json([\s\S]*?)```/g;

    let allQuestions: any[] = [];
    let match: RegExpExecArray | null;

    while ((match = jsonRegex.exec(aiMessage)) !== null) {
      const jsonBlock = match[1].trim();
      try {
        const parsed = JSON.parse(jsonBlock);
        if (Array.isArray(parsed)) {
          allQuestions = allQuestions.concat(parsed);
        } else {
          allQuestions.push(parsed);
        }
      } catch (err) {
        console.error('Error al parsear un bloque JSON:', err);
      }
    }

    if (allQuestions.length === 0) {
      console.warn('No se encontraron bloques JSON en la respuesta de la IA.');
    }

    return allQuestions;
  }
}
