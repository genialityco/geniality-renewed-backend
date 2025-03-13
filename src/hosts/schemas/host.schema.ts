import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Host extends Document {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  image: string;

  @Prop({ default: false })
  description_activity: boolean;

  @Prop({ required: true })
  description: string;

  @Prop({ default: null })
  profession: string;

  @Prop({ required: true })
  published: boolean;

  @Prop({ default: 0 })
  order: number;

  @Prop({ default: 0 })
  index: number;

  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  event_id: Types.ObjectId;

  @Prop({ type: [String], default: [] })
  activities_ids: string[];
}

export const HostSchema = SchemaFactory.createForClass(Host);
