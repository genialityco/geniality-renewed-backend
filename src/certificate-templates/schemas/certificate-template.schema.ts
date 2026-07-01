import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CertificateFieldType = 'TEXT' | 'EMAIL' | 'DATE' | 'NUMBER';
export type CertificateFieldDataSource =
  | 'userName'
  | 'eventName'
  | 'approvalPercentage'
  | 'custom';
export type CertificateFormat = 'PNG' | 'PDF';

@Schema({ _id: false })
export class TemplateFieldElement {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  label: string;

  @Prop({ type: String, enum: ['TEXT', 'EMAIL', 'DATE', 'NUMBER'], default: 'TEXT' })
  type: CertificateFieldType;

  @Prop({ default: false })
  required: boolean;

  @Prop({ default: null })
  defaultValue?: string;

  @Prop({
    type: String,
    enum: ['userName', 'eventName', 'approvalPercentage', 'custom'],
    default: 'custom',
  })
  dataSource: CertificateFieldDataSource;

  @Prop({ required: true })
  posX: number;

  @Prop({ required: true })
  posY: number;

  @Prop({ default: 200 })
  width: number;

  @Prop({ default: 36 })
  height: number;

  @Prop({ default: 16 })
  fontSize: number;

  @Prop({ default: 'Arial' })
  fontFamily: string;

  @Prop({ default: '#000000' })
  fontColor: string;

  @Prop({ type: String, enum: ['normal', 'bold'], default: 'normal' })
  fontWeight: 'normal' | 'bold';

  @Prop({ type: String, enum: ['left', 'center', 'right'], default: 'center' })
  textAlign: 'left' | 'center' | 'right';

  @Prop({ default: 0 })
  rotation: number;

  @Prop({ default: 0 })
  order: number;
}

export const TemplateFieldElementSchema =
  SchemaFactory.createForClass(TemplateFieldElement);

@Schema({ collection: 'certificate_templates', timestamps: true })
export class CertificateTemplate extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true, unique: true })
  eventId: Types.ObjectId;

  @Prop({ default: null })
  name?: string;

  @Prop({ default: null })
  description?: string;

  @Prop({ required: true })
  backgroundUrl: string;

  @Prop({ required: true })
  width: number;

  @Prop({ required: true })
  height: number;

  @Prop({ type: String, enum: ['PNG', 'PDF'], default: 'PNG' })
  format: CertificateFormat;

  @Prop({ type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' })
  status: 'ACTIVE' | 'INACTIVE';

  @Prop({ type: [TemplateFieldElementSchema], default: [] })
  fields: TemplateFieldElement[];
}

export const CertificateTemplateSchema =
  SchemaFactory.createForClass(CertificateTemplate);
