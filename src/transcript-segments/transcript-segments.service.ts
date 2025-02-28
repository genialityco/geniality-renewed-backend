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
    activityId: string, // Recibimos un string (por ejemplo) en el Controller
    segmentsData: Array<{
      startTime: number;
      endTime: number;
      text: string;
      embedding?: number[];
    }>,
  ): Promise<TranscriptSegmentDocument[]> {
    // <-- Retornamos el tipo de Documento
    // Convertimos activityId de string a ObjectId si lo queremos almacenar como tal
    const activityObjectId = new Types.ObjectId(activityId);

    // Primero, eliminar segmentos previos de esa actividad (opcional)
    await this.segmentModel.deleteMany({ activity_id: activityObjectId });

    // Creamos los nuevos documentos
    const createdDocs = await this.segmentModel.insertMany(
      segmentsData.map((seg) => ({
        activity_id: activityObjectId, // <--- Aseguramos que sea ObjectId, no string
        startTime: seg.startTime,
        endTime: seg.endTime,
        text: seg.text,
        embedding: seg.embedding || [],
      })),
    );

    // Mongoose retorna documentos con la forma Document<TranscriptSegment>
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
            index: 'default', // <-- el nombre del índice que creaste en Atlas
            text: {
              query: searchText, // la cadena que viene del frontend
              path: 'text', // el campo donde se busca
              fuzzy: {
                maxEdits: 1, // opcional: tolera "n" errores ortográficos
              },
            },
          },
        },
        {
          // Proyectamos únicamente los campos que necesitamos
          $project: {
            _id: 1,
            activity_id: 1,
            startTime: 1,
            endTime: 1,
            text: 1,
            score: { $meta: 'searchScore' },
          },
        },
        {
          // Ordenamos por relevancia (score mayor a menor)
          $sort: { score: -1 },
        },
        {
          // Agrupamos por la actividad
          $group: {
            _id: '$activity_id',
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
