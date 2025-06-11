import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  TranscriptSegment,
  TranscriptSegmentDocument,
} from './schemas/transcript-segment.schema';

@Injectable()
export class TranscriptSegmentsService {
  constructor(
    @InjectModel(TranscriptSegment.name)
    private readonly segmentModel: Model<TranscriptSegmentDocument>, // <--- Usamos TranscriptSegmentDocument
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

  async searchSegmentsGroupedByActivity(
    searchText: string,
    page = 1,
    pageSize = 10,
  ) {
    const skip = (page - 1) * pageSize;

    // 1. Pipeline base (igual a antes, sin paginar)
    const basePipeline = [
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
      { $limit: 2000 }, // limita antes de sort
      {
        $project: {
          _id: 1,
          activity_id: 1,
          startTime: 1,
          endTime: 1,
          text: 1,
          name_activity: 1,
          score: { $meta: 'searchScore' },
        },
      },
      { $sort: { score: -1 as 1 | -1 } },
      {
        $group: {
          _id: '$activity_id',
          name_activity: { $first: '$name_activity' },
          matchedSegments: {
            $push: {
              segmentId: '$_id',
              text: '$text',
              startTime: '$startTime',
              endTime: '$endTime',
              score: '$score',
            },
          },
          maxScore: { $max: '$score' },
          totalMatches: { $sum: 1 },
        },
      },
      { $sort: { maxScore: -1 as 1 | -1 } },
    ];

    // 2. Para el total, ejecuta el pipeline hasta aquí y cuenta resultados
    const countPipeline = [...basePipeline, { $count: 'total' }];
    const countResult = await this.segmentModel.aggregate(countPipeline).exec();
    const total = countResult[0]?.total || 0;

    // 3. Para los datos paginados
    const dataPipeline = [
      ...basePipeline,
      { $skip: skip },
      { $limit: pageSize },
    ];
    const data = await this.segmentModel.aggregate(dataPipeline).exec();

    return { data, total };
  }
}
