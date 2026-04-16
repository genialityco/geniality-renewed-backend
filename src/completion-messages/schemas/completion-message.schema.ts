import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, Schema as MongooseSchema } from 'mongoose';

interface Block {
  id: string;
  type: 'paragraph' | 'heading' | 'title';
  content: string;
}

export enum CompletionMessageType {
  MODULO_INICIO = 'MODULO_INICIO',
  MODULO_PROGRESO = 'MODULO_PROGRESO',
  MODULO_FINAL = 'MODULO_FINAL',
}

@Schema({ timestamps: true })
export class CompletionMessage extends Document {
  @Prop({ required: true, type: Types.ObjectId, ref: 'Organization' })
  organization_id: Types.ObjectId;

  @Prop({ 
    required: true, 
    enum: Object.values(CompletionMessageType),
    default: CompletionMessageType.MODULO_PROGRESO
  })
  type: CompletionMessageType;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  blocks: Block[];

  @Prop({ default: true })
  active: boolean;

  @Prop({ default: 1 })
  order: number;

  @Prop({ type: Date, default: Date.now })
  createdAt: Date;

  @Prop({ type: Date, default: Date.now })
  updatedAt: Date;
}

export const CompletionMessageSchema = SchemaFactory.createForClass(CompletionMessage);
