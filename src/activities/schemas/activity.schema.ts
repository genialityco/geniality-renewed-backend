import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type VideoProvider = 'vimeo' | 'bunny';
export type VideoStatus = 'active' | 'inactive' | 'processing' | 'error';

@Schema({ _id: false })
export class VideoItem {
  @Prop({ required: true })
  provider: VideoProvider;

  @Prop({ required: true })
  video_id: string;

  @Prop({ default: 0 })
  priority: number;

  @Prop({ default: 'active' })
  status: VideoStatus;

  @Prop({ type: Object, default: {} })
  meta: Record<string, any>;
}

export const VideoItemSchema = SchemaFactory.createForClass(VideoItem);

@Schema({ collection: 'activities_test', timestamps: true })
export class Activity extends Document {
  @Prop({ required: true })
  name: string;

  @Prop()
  datetime_start: string;

  @Prop()
  datetime_end: string;

  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  event_id: Types.ObjectId;

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

  @Prop({ type: [VideoItemSchema], default: [] })
  videos: VideoItem[];

  @Prop({ default: 0 })
  video_progress: number;

  @Prop({ default: false })
  is_info_only: boolean;

  @Prop({ default: [] })
  selected_document: string[];

  @Prop({ default: null })
  type_id: string;

  @Prop({ default: null })
  module_id: string;

  @Prop({
    type: Types.ObjectId,
    ref: 'Organization',
    default: null,
  })
  organization_id?: Types.ObjectId;

  @Prop({ default: false })
  transcript_available: boolean;

  @Prop({ default: null })
  transcription_job_id: string;

  @Prop({ default: null })
  textTranscription: string;
}

export const ActivitySchema = SchemaFactory.createForClass(Activity);
