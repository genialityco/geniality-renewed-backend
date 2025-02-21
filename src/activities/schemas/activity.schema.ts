import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ collection: 'activities', timestamps: true })
export class Activity extends Document {
  @Prop({ required: true })
  name: string;

  @Prop()
  datetime_start: string;

  @Prop()
  datetime_end: string;

  @Prop({ required: true })
  event_id: string;

  @Prop()
  date_start_zoom: string;

  @Prop()
  date_end_zoom: string;

  @Prop({ default: null })
  description: string;

  @Prop({ default: null })
  short_description: string;

  @Prop({ type: [String], default: [] })
  host_ids: string[];

  @Prop({ default: null })
  video: string;

  @Prop({ default: 0 })
  video_progress: number;

  @Prop({ default: false })
  is_info_only: boolean;

  @Prop({ default: [] })
  selected_document: string[];

  @Prop({ default: null })
  type_id: string;

  @Prop({ default: null })
  transcription_id: string;

  @Prop({ default: null })
  module_id: string;
}

export const ActivitySchema = SchemaFactory.createForClass(Activity);
