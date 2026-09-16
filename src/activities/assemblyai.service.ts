import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';

export interface AssemblyAiTranscriptResult {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  text?: string;
  error?: string;
}

export interface AssemblyAiSentence {
  text: string;
  start: number;
  end: number;
}

const ASSEMBLYAI_BASE_URL = 'https://api.assemblyai.com/v2';

@Injectable()
export class AssemblyAiService {
  private readonly logger = new Logger(AssemblyAiService.name);

  constructor(private readonly httpService: HttpService) {}

  private get authHeader() {
    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      throw new BadRequestException(
        'ASSEMBLYAI_API_KEY no está configurada en el entorno',
      );
    }
    return { authorization: apiKey };
  }

  /**
   * Envía un audio/video público a AssemblyAI para transcripción.
   * Retorna el id del transcript, usado luego para hacer polling.
   */
  async submitTranscription(audioUrl: string): Promise<string> {
    try {
      const response$ = this.httpService.post(
        `${ASSEMBLYAI_BASE_URL}/transcript`,
        {
          audio_url: audioUrl,
          speech_models: ['universal-3-5-pro'],
          language_code: 'es',
        },
        { headers: this.authHeader },
      );
      const response = await lastValueFrom(response$);
      const data = response.data;

      if (!data?.id) {
        throw new BadRequestException(
          `AssemblyAI no devolvió un id de transcript. Respuesta: ${JSON.stringify(data)}`,
        );
      }

      this.logger.log(`✅ Transcript enviado a AssemblyAI: ${data.id}`);
      return data.id;
    } catch (error: any) {
      this.logger.error(
        `Error al enviar transcript a AssemblyAI: ${error.response?.data?.error || error.message}`,
      );
      throw new BadRequestException(
        `Failed to submit transcription to AssemblyAI: ${
          error.response?.data?.error || error.message || 'Unknown error'
        }`,
      );
    }
  }

  /**
   * Consulta el estado/resultado de un transcript.
   */
  async getTranscriptionResult(
    transcriptId: string,
  ): Promise<AssemblyAiTranscriptResult> {
    const response$ = this.httpService.get(
      `${ASSEMBLYAI_BASE_URL}/transcript/${transcriptId}`,
      { headers: this.authHeader },
    );
    const response = await lastValueFrom(response$);
    return response.data;
  }

  /**
   * Devuelve el transcript ya segmentado por oración (con timestamps), para
   * poblar transcript_segments. Solo válido una vez que el transcript está
   * "completed" — a diferencia de `utterances` (que agrupa por turno de
   * hablante y puede devolver un solo bloque gigante si hay un único
   * speaker), esto da la granularidad fina que necesita el visor.
   */
  async getSentences(transcriptId: string): Promise<AssemblyAiSentence[]> {
    const response$ = this.httpService.get(
      `${ASSEMBLYAI_BASE_URL}/transcript/${transcriptId}/sentences`,
      { headers: this.authHeader },
    );
    const response = await lastValueFrom(response$);
    return response.data?.sentences || [];
  }
}
