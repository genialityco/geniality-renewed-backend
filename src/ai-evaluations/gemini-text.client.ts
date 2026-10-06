import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

/**
 * Generación de texto con Gemini vía REST (mismo estilo que EmbeddingService).
 * `generateJson` pide `responseMimeType: application/json`, así que la
 * respuesta llega como JSON parseable sin bloques ```json.
 */
@Injectable()
export class GeminiTextClient {
  private readonly logger = new Logger(GeminiTextClient.name);
  private readonly apiKey = process.env.GEMINI_API_KEY || '';
  private readonly model = process.env.GEMINI_CHAT_MODEL || DEFAULT_MODEL;

  async generateJson<T>(
    system: string,
    prompt: string,
    temperature = 0.3,
    timeoutMs = 90000,
  ): Promise<T> {
    const url = `${GEMINI_API_BASE}/models/${this.model}:generateContent`;
    try {
      const { data } = await axios.post<GenerateContentResponse>(
        url,
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature,
            responseMimeType: 'application/json',
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
          },
          timeout: timeoutMs,
        },
      );
      const text = (data.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text || '')
        .join('');
      return parseJson<T>(text);
    } catch (error) {
      this.logger.error(
        `Gemini generateContent falló: ${
          (error as any)?.response?.data?.error?.message ||
          (error as Error).message
        }`,
      );
      throw error;
    }
  }
}

/** Tolera texto o bloques ```json alrededor del JSON. */
function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = Math.min(
      ...[raw.indexOf('['), raw.indexOf('{')].filter((i) => i !== -1),
    );
    const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
    if (!Number.isFinite(start) || end < start) {
      throw new Error('La respuesta de Gemini no contiene JSON');
    }
    return JSON.parse(raw.slice(start, end + 1));
  }
}
