import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  TranscriptSegment,
  TranscriptSegmentDocument,
} from './schemas/transcript-segment.schema';
import { EmbeddingService } from './embedding.service';

// Nombre del índice de Atlas Vector Search sobre el campo `embedding`.
// Ajustar vía env var si el índice se creó con otro nombre en Atlas.
const VECTOR_SEARCH_INDEX =
  process.env.MONGO_VECTOR_SEARCH_INDEX || 'vector_index';

// Cuántos candidatos se piden a cada motor (texto y vector) antes de
// fusionarlos. Más alto = mejor recall, más lento.
const CANDIDATE_LIMIT = 300;

// Constante estándar de Reciprocal Rank Fusion (valor típico en literatura
// de IR; suaviza el peso de las posiciones más bajas del ranking).
const RRF_K = 60;

interface RankableSegment {
  _id: Types.ObjectId | string;
  activity_id: Types.ObjectId | string;
  startTime: number;
  endTime: number;
  text: string;
  name_activity?: string;
}

// De qué motor salió el match: 'text' (Atlas Search/fuzzy), 'vector'
// (Atlas Vector Search/semántico), o 'hybrid' (apareció en ambos).
export type SearchMatchSource = 'text' | 'vector' | 'hybrid';

export interface TranscriptSearchResult {
  _id: string;
  name_activity?: string;
  matchedSegments: Array<{
    segmentId: string;
    text: string;
    startTime: number;
    endTime: number;
    score: number;
    source: SearchMatchSource;
  }>;
  totalMatches: number;
}

@Injectable()
export class TranscriptSegmentsService {
  private readonly logger = new Logger(TranscriptSegmentsService.name);

  constructor(
    @InjectModel(TranscriptSegment.name)
    private readonly segmentModel: Model<TranscriptSegmentDocument>, // <--- Usamos TranscriptSegmentDocument
    private readonly embeddingService: EmbeddingService,
  ) {}

  /**
   * Crea múltiples segmentos de una sola vez (e.g. tras procesar el video).
   */
  async createSegments(
    activityId: string,
    segmentsData: Array<{
      startTime: number;
      endTime: number;
      text: string;
      embedding?: number[];
    }>,
  ): Promise<TranscriptSegmentDocument[]> {
    if (!Array.isArray(segmentsData) || segmentsData.length === 0) {
      throw new Error('segmentsData no es un array válido.');
    }

    const activityObjectId = new Types.ObjectId(activityId);

    await this.segmentModel.deleteMany({ activity_id: activityObjectId });

    const createdDocs = await this.segmentModel.insertMany(
      segmentsData.map((seg) => ({
        activity_id: activityObjectId,
        startTime: seg.startTime,
        endTime: seg.endTime,
        text: seg.text,
        embedding: seg.embedding || [],
      })),
    );

    // Vectorización automática al crear los segmentos (p.ej. justo después de
    // que termina la transcripción de un video recién subido). Fire-and-forget:
    // un fallo acá (rate limit, OpenAI caído, etc.) no debe tumbar el flujo de
    // transcripción ni dejar `transcript_available` sin marcarse; los
    // segmentos sin embedding quedan disponibles para el backfill manual.
    const pending = createdDocs.filter((doc) => !doc.embedding?.length);
    if (pending.length) {
      this.embedAndPersist(pending).catch((error) => {
        this.logger.error(
          `Error generando embeddings automáticos para la actividad ${activityId}: ${error.message}`,
        );
      });
    }

    return createdDocs;
  }

  /**
   * Retorna todos los segmentos de una actividad.
   */
  async getSegmentsByActivity(
    activityId: string,
  ): Promise<TranscriptSegmentDocument[]> {
    const activityObjectId = new Types.ObjectId(activityId);
    return this.segmentModel.find({ activity_id: activityObjectId }).exec();
  }

  /**
   * Recalcula embeddings para cada segmento (opcional).
   */
  async updateEmbeddings(activityId: string, embeddings: number[][]) {
    const activityObjectId = new Types.ObjectId(activityId);
    const segments = await this.segmentModel.find({
      activity_id: activityObjectId,
    });

    if (segments.length !== embeddings.length) {
      throw new Error(
        'Cantidad de embeddings no coincide con la cantidad de segmentos',
      );
    }

    for (let i = 0; i < segments.length; i++) {
      segments[i].embedding = embeddings[i];
      await segments[i].save();
    }
  }

  /**
   * Genera y almacena el embedding de un segmento individual (vectorización
   * manual puntual, p.ej. un botón "regenerar" sobre un segmento específico).
   */
  async generateEmbeddingForSegment(
    segmentId: string,
  ): Promise<TranscriptSegmentDocument> {
    const segment = await this.segmentModel.findById(segmentId);
    if (!segment) {
      throw new NotFoundException(
        `Transcript segment with ID ${segmentId} not found`,
      );
    }
    if (!segment.text) {
      throw new BadRequestException(
        'Segment does not have text to generate embedding',
      );
    }

    try {
      const [embedding] = await this.embeddingService.embedTexts([
        segment.text,
      ]);
      segment.embedding = embedding;
      await segment.save();
      return segment;
    } catch (error: any) {
      this.logger.error(
        `Error generando embedding para el segmento ${segmentId}: ${error.message}`,
      );
      throw new BadRequestException(
        `Failed to generate embedding: ${error.message || 'Unknown error'}`,
      );
    }
  }

  /**
   * Vectoriza manualmente los segmentos de una actividad (p.ej. botón
   * "Generar embeddings" en el admin de la actividad). Por defecto solo
   * procesa los que aún no tienen embedding; `force` regenera todos (útil
   * tras cambiar de modelo/dimensión).
   */
  async generateEmbeddingsForActivity(
    activityId: string,
    force = false,
  ): Promise<{ total: number; updated: number }> {
    const activityObjectId = new Types.ObjectId(activityId);
    const filter: Record<string, any> = { activity_id: activityObjectId };
    if (!force) {
      filter.$or = [
        { embedding: { $exists: false } },
        { embedding: { $size: 0 } },
      ];
    }

    const segments = await this.segmentModel.find(filter);
    if (!segments.length) {
      return { total: 0, updated: 0 };
    }

    await this.embedAndPersist(segments);
    return { total: segments.length, updated: segments.length };
  }

  /**
   * Backfill global: vectoriza segmentos sin embedding de cualquier
   * actividad, hasta `limit` por llamada (para no bloquear la request ni
   * saturar la API de OpenAI de una sola vez). Devuelve `remaining` para que
   * quien lo llama (botón de admin o script) repita la llamada hasta vaciar
   * el backlog.
   */
  async generateMissingEmbeddings(
    limit = 200,
  ): Promise<{ updated: number; remaining: number }> {
    const filter = {
      $or: [{ embedding: { $exists: false } }, { embedding: { $size: 0 } }],
    };

    const segments = await this.segmentModel.find(filter).limit(limit);
    if (!segments.length) {
      return { updated: 0, remaining: 0 };
    }

    await this.embedAndPersist(segments);

    const remaining = await this.segmentModel.countDocuments(filter);
    return { updated: segments.length, remaining };
  }

  /**
   * Regenera el embedding de TODOS los segmentos (de cualquier actividad),
   * incluso los que ya tienen uno — a diferencia de `generateMissingEmbeddings`,
   * que solo rellena los vacíos. Útil tras cambiar de modelo/dimensión (p.ej.
   * quedaron algunos con 3072 y hay que pasarlos todos a 768).
   *
   * Pagina por `_id` (keyset, no `skip`) porque al reprocesar todo no se puede
   * usar un filtro que se "vacíe" solo como en el backfill de faltantes:
   * cada llamada recibe `afterId` (el `nextCursor` de la llamada anterior) y
   * sigue desde ahí hasta que `nextCursor` sale `null`.
   */
  async generateAllEmbeddings(
    limit = 200,
    afterId?: string,
  ): Promise<{ updated: number; nextCursor: string | null }> {
    const filter: Record<string, any> = {};
    if (afterId) {
      filter._id = { $gt: new Types.ObjectId(afterId) };
    }

    const segments = await this.segmentModel
      .find(filter)
      .sort({ _id: 1 })
      .limit(limit);

    if (!segments.length) {
      return { updated: 0, nextCursor: null };
    }

    await this.embedAndPersist(segments);

    const lastId = segments[segments.length - 1]._id;
    const hasMore = await this.segmentModel.exists({
      _id: { $gt: lastId },
    });

    return {
      updated: segments.length,
      nextCursor: hasMore ? String(lastId) : null,
    };
  }

  /**
   * Genera embeddings en lotes (vía EmbeddingService) y los persiste con un
   * único `bulkWrite` en vez de un `.save()` por documento.
   */
  private async embedAndPersist(
    segments: TranscriptSegmentDocument[],
  ): Promise<void> {
    const texts = segments.map((s) => s.text);
    const embeddings = await this.embeddingService.embedTextsInBatches(texts);

    const ops = segments.map((segment, i) => ({
      updateOne: {
        filter: { _id: segment._id },
        update: { $set: { embedding: embeddings[i] } },
      },
    }));

    await this.segmentModel.bulkWrite(ops);
  }

  /**
   * Candidatos por texto (Atlas Search, fuzzy sobre `name_activity`/`text`).
   * Sin agrupar ni paginar: se usan como una de las dos listas rankeadas que
   * `searchSegmentsGroupedByActivity` fusiona.
   */
  private async textSearchCandidates(
    searchText: string,
    limit: number,
  ): Promise<RankableSegment[]> {
    const pipeline = [
      {
        $search: {
          index: 'default',
          compound: {
            should: [
              {
                text: {
                  query: searchText,
                  path: 'name_activity',
                  score: { boost: { value: 20 } },
                  fuzzy: { maxEdits: 1 },
                },
              },
              {
                text: {
                  query: searchText,
                  path: 'text',
                  score: { boost: { value: 5 } },
                  fuzzy: { maxEdits: 1 },
                },
              },
            ],
            minimumShouldMatch: 1,
          },
        },
      },
      { $limit: limit },
      {
        $project: {
          _id: 1,
          activity_id: 1,
          startTime: 1,
          endTime: 1,
          text: 1,
          name_activity: 1,
        },
      },
    ];

    return this.segmentModel.aggregate(pipeline).exec();
  }

  /**
   * Candidatos por similitud semántica (Atlas Vector Search sobre
   * `embedding`). Devuelve `[]` en vez de lanzar si falla (índice mal
   * configurado, sin API key, backlog de embeddings sin generar, etc.) para
   * que la búsqueda híbrida siga funcionando solo con texto.
   */
  private async vectorSearchCandidates(
    searchText: string,
    limit: number,
  ): Promise<RankableSegment[]> {
    try {
      const queryVector = await this.embeddingService.embedQuery(searchText);
      const pipeline = [
        {
          $vectorSearch: {
            index: VECTOR_SEARCH_INDEX,
            path: 'embedding',
            queryVector,
            numCandidates: Math.min(limit * 10, 1000),
            limit,
          },
        },
        {
          $project: {
            _id: 1,
            activity_id: 1,
            startTime: 1,
            endTime: 1,
            text: 1,
            name_activity: 1,
          },
        },
      ];

      return await this.segmentModel.aggregate(pipeline).exec();
    } catch (error: any) {
      this.logger.warn(
        `Vector search no disponible, se usa solo texto: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Búsqueda híbrida: combina texto (Atlas Search) y semántica (Atlas Vector
   * Search) fusionando ambos rankings con Reciprocal Rank Fusion (RRF) — cada
   * segmento suma `1 / (RRF_K + posición)` por cada lista en la que aparece,
   * así que uno que sale bien ubicado en ambas queda primero sin tener que
   * normalizar/comparar escalas de score distintas entre los dos motores.
   * Agrupa por actividad (igual que antes) y pagina los grupos resultantes.
   */
  async searchSegmentsGroupedByActivity(
    searchText: string,
    page = 1,
    pageSize = 10,
  ): Promise<{ data: TranscriptSearchResult[]; total: number }> {
    const [textResults, vectorResults] = await Promise.all([
      this.textSearchCandidates(searchText, CANDIDATE_LIMIT),
      this.vectorSearchCandidates(searchText, CANDIDATE_LIMIT),
    ]);

    // Reciprocal Rank Fusion por segmento. Además de sumar el score por cada
    // lista en la que aparece, se registra EN CUÁLES aparece (`sources`)
    // para que el frontend pueda distinguir visualmente un match textual de
    // uno semántico (o ambos, "hybrid") sin tener que adivinarlo del score.
    const fused = new Map<
      string,
      { doc: RankableSegment; score: number; sources: Set<'text' | 'vector'> }
    >();
    const addRanked = (list: RankableSegment[], source: 'text' | 'vector') => {
      list.forEach((doc, index) => {
        const key = String(doc._id);
        const rrf = 1 / (RRF_K + index + 1);
        const existing = fused.get(key);
        if (existing) {
          existing.score += rrf;
          existing.sources.add(source);
        } else {
          fused.set(key, { doc, score: rrf, sources: new Set([source]) });
        }
      });
    };
    addRanked(textResults, 'text');
    addRanked(vectorResults, 'vector');

    // Agrupar los segmentos fusionados por actividad.
    const groups = new Map<string, TranscriptSearchResult & { maxScore: number }>();
    for (const { doc, score, sources } of fused.values()) {
      const activityKey = String(doc.activity_id);
      let group = groups.get(activityKey);
      if (!group) {
        group = {
          _id: activityKey,
          name_activity: doc.name_activity,
          matchedSegments: [],
          totalMatches: 0,
          maxScore: 0,
        };
        groups.set(activityKey, group);
      }
      const source: SearchMatchSource =
        sources.size > 1 ? 'hybrid' : sources.has('vector') ? 'vector' : 'text';
      group.matchedSegments.push({
        segmentId: String(doc._id),
        text: doc.text,
        startTime: doc.startTime,
        endTime: doc.endTime,
        score,
        source,
      });
      group.totalMatches += 1;
      group.maxScore = Math.max(group.maxScore, score);
    }

    const sortedGroups = [...groups.values()].sort(
      (a, b) => b.maxScore - a.maxScore,
    );
    sortedGroups.forEach((group) =>
      group.matchedSegments.sort((a, b) => b.score - a.score),
    );

    const total = sortedGroups.length;
    const skip = (page - 1) * pageSize;
    const data = sortedGroups
      .slice(skip, skip + pageSize)
      // No exponer el campo interno `maxScore` usado solo para ordenar.
      .map(({ maxScore: _maxScore, ...group }) => group);

    return { data, total };
  }
}
