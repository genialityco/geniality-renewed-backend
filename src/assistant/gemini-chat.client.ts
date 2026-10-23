import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
}

interface Part {
  text?: string;
  functionCall?: { name: string; args?: Record<string, any> };
  functionResponse?: { name: string; response: Record<string, any> };
  // Gemini 3 devuelve firmas que hay que reenviar tal cual
  [key: string]: any;
}

interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

/**
 * Conversación con Gemini con llamadas a funciones (REST, mismo estilo que
 * GeminiTextClient): el modelo pide herramientas, se ejecutan aquí y se le
 * devuelven los resultados hasta que responde con texto.
 */
@Injectable()
export class GeminiChatClient {
  private readonly logger = new Logger(GeminiChatClient.name);
  private readonly apiKey = process.env.GEMINI_API_KEY || '';
  private readonly model = process.env.ASSISTANT_GEMINI_MODEL || DEFAULT_MODEL;

  async chat(params: {
    system: string;
    history: ChatTurn[];
    message: string;
    tools: ToolDeclaration[];
    runTool: (name: string, args: Record<string, any>) => Promise<unknown>;
    maxSteps?: number;
  }): Promise<{ text: string; calls: { name: string; args: Record<string, any>; ok: boolean }[] }> {
    const contents: Content[] = [
      ...params.history.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
      { role: 'user', parts: [{ text: params.message }] },
    ];
    const calls: { name: string; args: Record<string, any>; ok: boolean }[] = [];
    const maxSteps = params.maxSteps ?? 4;

    for (let step = 0; step <= maxSteps; step++) {
      // En el último paso ya no se ofrecen herramientas: debe responder
      const content = await this.generate(
        params.system,
        contents,
        step < maxSteps ? params.tools : [],
      );
      const parts = content?.parts || [];
      const requested = parts.filter((p) => p.functionCall);
      if (!requested.length) {
        const text = parts
          .map((p) => p.text || '')
          .join('')
          .trim();
        return { text, calls };
      }
      // Se reenvía la respuesta del modelo completa (con sus firmas)
      contents.push({ role: 'model', parts });
      const responses: Part[] = [];
      for (const p of requested) {
        const { name, args = {} } = p.functionCall!;
        let result: unknown;
        let ok = true;
        try {
          result = await params.runTool(name, args);
        } catch (error) {
          ok = false;
          result = { error: (error as Error).message };
        }
        calls.push({ name, args, ok });
        responses.push({ functionResponse: { name, response: { result } } });
      }
      contents.push({ role: 'user', parts: responses });
    }
    return { text: '', calls };
  }

  private async generate(
    system: string,
    contents: Content[],
    tools: ToolDeclaration[],
  ): Promise<Content | undefined> {
    const url = `${GEMINI_API_BASE}/models/${this.model}:generateContent`;
    try {
      const { data } = await axios.post(
        url,
        {
          systemInstruction: { parts: [{ text: system }] },
          contents,
          ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
          generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
          },
          timeout: 60000,
        },
      );
      return data?.candidates?.[0]?.content;
    } catch (error) {
      this.logger.error(
        `Gemini (asistente) falló: ${
          (error as any)?.response?.data?.error?.message || (error as Error).message
        }`,
      );
      throw error;
    }
  }
}
