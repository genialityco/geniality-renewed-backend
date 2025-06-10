import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ collection: 'transcript_segments', timestamps: true })
export class TranscriptSegment {
  @Prop({ type: Types.ObjectId, ref: 'Activity', required: true })
  activity_id: Types.ObjectId;

  @Prop({ required: true })
  startTime: number;

  @Prop({ required: true })
  endTime: number;

  @Prop({ required: true })
  text: string;

  @Prop({ required: false })
  name_activity: string;

  @Prop({ type: [Number], default: [] })
  embedding: number[];
}

// Aquí creamos el "type" que representa el documento
export type TranscriptSegmentDocument = TranscriptSegment & Document;

// Generamos el schema a partir de la clase
export const TranscriptSegmentSchema =
  SchemaFactory.createForClass(TranscriptSegment);
