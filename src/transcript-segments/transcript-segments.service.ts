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

  async searchSegmentsGroupedByActivity(searchText: string) {
    return this.segmentModel
      .aggregate([
        {
          $search: {
            index: 'default', // nombre del índice de búsqueda de texto en MongoDB Atlas
            text: {
              query: searchText, // texto a buscar
              path: 'text', // campo donde buscar
              fuzzy: {
                maxEdits: 1, // permite errores ortográficos leves
              },
            },
          },
        },
        {
          $project: {
            _id: 1,
            activity_id: 1,
            startTime: 1,
            endTime: 1,
            text: 1,
            score: { $meta: 'searchScore' }, // relevancia de la coincidencia
          },
        },
        {
          $sort: { score: -1 }, // ordena por relevancia
        },
        {
          $group: {
            _id: '$activity_id', // agrupa por actividad
            matchedSegments: {
              $push: {
                segmentId: '$_id',
                text: '$text',
                startTime: '$startTime',
                endTime: '$endTime',
                score: '$score',
              },
            },
            totalMatches: { $sum: 1 },
          },
        },
      ])
      .exec();
  }
}
