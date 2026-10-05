import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

// gemini-embedding-2 (y gemini-embedding-001) generan 3072 dimensiones de
// forma NATIVA por defecto. Para obtener 768 hay que pedirlo explícitamente
// con `outputDimensionality` — si no se manda ese parámetro, Gemini devuelve
// el tamaño completo (3072) sin avisar. El SDK viejo `@google/generative-ai`
// no expone ese parámetro, así que acá se llama la API REST directamente.
// 768/1536/3072 son los tamaños "recomendados" por Google (modelo entrenado
// con Matryoshka Representation Learning): con esos valores el vector queda
// unit-normalized sin pasos extra; con cualquier otro tamaño habría que
// normalizarlo manualmente.
// Ref: https://ai.google.dev/gemini-api/docs/embeddings
//
// El índice de Atlas Vector Search sobre `embedding` debe declarar
// `numDimensions` exactamente igual a este valor, o si se cambia el modelo.
const DEFAULT_MODEL = 'gemini-embedding-2';
const DEFAULT_DIMENSIONS = 768;

// Límite de la API de Gemini para `batchEmbedContents` por request.
const MAX_BATCH_SIZE = 100;

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiEmbedding {
  values: number[];
}

interface BatchEmbedContentsResponse {
  embeddings: GeminiEmbedding[];
}

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly apiKey: string;
  private readonly modelName: string;
  readonly dimensions: number;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || '';
    this.modelName = process.env.GEMINI_EMBEDDING_MODEL || DEFAULT_MODEL;
    this.dimensions =
      Number(process.env.GEMINI_EMBEDDING_DIMENSIONS) || DEFAULT_DIMENSIONS;
  }

  /**
   * Genera embeddings para un lote de textos en una sola llamada a Gemini
   * (máximo `MAX_BATCH_SIZE` por request). Devuelve los vectores en el mismo
   * orden que `texts`, ya truncados a `this.dimensions` vía
   * `outputDimensionality`.
   *
   * `taskType` importa para la calidad de la búsqueda: los segmentos que se
   * guardan en Mongo deben usar `RETRIEVAL_DOCUMENT` (default); la consulta
   * que escribe el usuario en el buscador debe usar `RETRIEVAL_QUERY` (ver
   * `embedQuery`) — Gemini genera vectores distintos a propósito para cada
   * rol, y mezclarlos degrada la relevancia.
   */
  async embedTexts(
    texts: string[],
    taskType: string = 'RETRIEVAL_DOCUMENT',
  ): Promise<number[][]> {
    if (!texts.length) return [];
    if (texts.length > MAX_BATCH_SIZE) {
      throw new Error(
        `embedTexts recibió ${texts.length} textos; usa embedTextsInBatches (máx ${MAX_BATCH_SIZE} por llamada).`,
      );
    }

    const url = `${GEMINI_API_BASE}/models/${this.modelName}:batchEmbedContents`;

    try {
      const response = await axios.post<BatchEmbedContentsResponse>(
        url,
        {
          requests: texts.map((text) => ({
            model: `models/${this.modelName}`,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: this.dimensions,
          })),
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
          },
        },
      );

      return response.data.embeddings.map((e) => e.values);
    } catch (error: any) {
      this.logger.error(
        `Error llamando a Gemini embeddings: ${
          error.response?.data?.error?.message || error.message
        }`,
      );
      throw error;
    }
  }

  /**
   * Igual que `embedTexts`, pero troceando en lotes para no exceder el
   * límite de la API ni disparar un solo request gigante en backfills
   * grandes.
   */
  async embedTextsInBatches(
    texts: string[],
    batchSize = MAX_BATCH_SIZE,
    taskType: string = 'RETRIEVAL_DOCUMENT',
  ): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      this.logger.debug(
        `Generando embeddings ${i + 1}-${i + batch.length} de ${texts.length}`,
      );
      const embeddings = await this.embedTexts(batch, taskType);
      results.push(...embeddings);
    }
    return results;
  }

  /**
   * Embebe la consulta del buscador con `taskType: RETRIEVAL_QUERY` (el rol
   * correcto para el lado "pregunta" de una búsqueda semántica).
   */
  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embedTexts([text], 'RETRIEVAL_QUERY');
    return vector;
  }
}
