import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
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
    scope?: Record<string, any>,
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
      ...(scope ? [{ $match: scope }] : []),
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
    scope?: Record<string, any>,
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
        // Filtro posterior: el índice vectorial no declara activity_id como
        // filtro, así que se acota después (menos recall en cursos chicos)
        ...(scope ? [{ $match: scope }] : []),
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
   * Fusión RRF de la búsqueda de texto y la semántica, solo dentro de
   * `activityIds`, sin fragmentos demasiado cortos (una frase de 4 palabras
   * se parece semánticamente a casi cualquier cosa) ni repetidos.
   */
  private async fuseInActivities(
    searchText: string,
    activityIds: unknown[],
    minChars: number,
  ) {
    const query = String(searchText || '').trim();
    if (!query || !activityIds.length) return [];
    const ids = activityIds.flatMap((id) => {
      const value = String(id);
      return Types.ObjectId.isValid(value)
        ? [value, new Types.ObjectId(value)]
        : [value];
    });
    const scope = {
      activity_id: { $in: ids },
      $expr: { $gte: [{ $strLenCP: { $ifNull: ['$text', ''] } }, minChars] },
    };
    const [textResults, vectorResults] = await Promise.all([
      this.textSearchCandidates(query, 50, scope).catch((error) => {
        this.logger.warn(`Búsqueda de texto acotada falló: ${error.message}`);
        return [] as RankableSegment[];
      }),
      this.vectorSearchCandidates(query, CANDIDATE_LIMIT, scope),
    ]);

    const fused = new Map<string, { doc: RankableSegment; score: number }>();
    const addRanked = (list: RankableSegment[]) => {
      list.forEach((doc, index) => {
        const key = String(doc._id);
        const rrf = 1 / (RRF_K + index + 1);
        const existing = fused.get(key);
        if (existing) existing.score += rrf;
        else fused.set(key, { doc, score: rrf });
      });
    };
    addRanked(textResults);
    addRanked(vectorResults);

    // El mismo texto en varias actividades (intros, frases repetidas) cuenta una vez
    const seenText = new Set<string>();
    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .filter(({ doc }) => {
        const key = String(doc.text || '')
          .trim()
          .toLowerCase();
        if (seenText.has(key)) return false;
        seenText.add(key);
        return true;
      });
  }

  /**
   * Mejores momentos del video para un tema, solo dentro de `activityIds`
   * (p. ej. las actividades de un curso): el mejor fragmento de cada
   * actividad, hasta `max`.
   */
  async searchMomentsInActivities(
    searchText: string,
    activityIds: unknown[],
    max = 2,
  ): Promise<
    {
      activity_id: string;
      name_activity?: string;
      startTime: number;
      score: number;
    }[]
  > {
    const ranked = await this.fuseInActivities(searchText, activityIds, 40);
    const bestByActivity = new Map<
      string,
      { doc: RankableSegment; score: number }
    >();
    for (const entry of ranked) {
      const key = String(entry.doc.activity_id);
      if (!bestByActivity.has(key)) bestByActivity.set(key, entry);
    }
    return [...bestByActivity.values()].slice(0, max).map(({ doc, score }) => ({
      activity_id: String(doc.activity_id),
      name_activity: doc.name_activity,
      startTime: doc.startTime,
      score,
    }));
  }

  /**
   * Candidatos para que la IA elija el momento que realmente explica un tema:
   * los `limit` mejores fragmentos (hasta 2 por actividad) con el texto del
   * minuto siguiente como contexto.
   */
  async searchCandidatesInActivities(
    searchText: string,
    activityIds: unknown[],
    limit = 6,
  ): Promise<
    {
      activity_id: string;
      name_activity?: string;
      startTime: number;
      context: string;
    }[]
  > {
    const ranked = await this.fuseInActivities(searchText, activityIds, 40);
    const perActivity = new Map<string, number>();
    const picked = ranked
      .filter(({ doc }) => {
        const key = String(doc.activity_id);
        const n = perActivity.get(key) || 0;
        if (n >= 2) return false;
        perActivity.set(key, n + 1);
        return true;
      })
      .slice(0, limit);
    return Promise.all(
      picked.map(async ({ doc }) => {
        const window = await this.segmentModel
          .find({
            activity_id: doc.activity_id,
            startTime: { $gte: doc.startTime, $lt: doc.startTime + 60 },
          })
          .select('text')
          .sort({ startTime: 1 })
          .limit(12)
          .lean()
          .exec();
        return {
          activity_id: String(doc.activity_id),
          name_activity: doc.name_activity,
          startTime: doc.startTime,
          context: window
            .map((w) => w.text)
            .join(' ')
            .slice(0, 450),
        };
      }),
    );
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
    const groups = new Map<
      string,
      TranscriptSearchResult & { maxScore: number }
    >();
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
