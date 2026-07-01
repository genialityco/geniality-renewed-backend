import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type CertificateStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

@Schema({ collection: 'certificates', timestamps: true })
export class Certificate extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true, index: true })
  eventId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'CertificateTemplate', required: true })
  templateId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  userId?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  data: Record<string, string | number>;

  @Prop({ type: String, enum: ['PNG', 'PDF'], default: 'PNG' })
  format: 'PNG' | 'PDF';

  @Prop({ default: null })
  filePath?: string;

  @Prop({ default: null })
  fileUrl?: string;

  @Prop({ type: String, enum: ['PENDING', 'COMPLETED', 'FAILED'], default: 'PENDING' })
  status: CertificateStatus;

  @Prop({ default: null })
  errorMessage?: string;

  @Prop({ default: null })
  generatedAt?: Date;
}

export const CertificateSchema = SchemaFactory.createForClass(Certificate);
