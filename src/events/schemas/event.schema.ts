import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Event extends Document {
  @Prop({ required: true }) name: string;
  @Prop() address?: string;
  @Prop({ required: true }) type_event: 'onlineEvent' | 'inPerson';
  @Prop({ required: true }) datetime_from: Date;
  @Prop({ required: true }) datetime_to: Date;
  @Prop() picture?: string;
  @Prop() venue?: string;
  @Prop() location?: string;
  @Prop({ required: true }) visibility: 'PUBLIC' | 'PRIVATE';
  @Prop() description?: string;
  @Prop() allow_register: boolean;
  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true })
  organizer_id: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  author_id: Types.ObjectId;
  @Prop({ type: [String], default: [] }) position_ids?: string[];
  @Prop() event_platform?: 'zoom' | 'google_meet' | 'microsoft_teams';
  @Prop({ default: 'es' }) language?: string;
  @Prop({ default: 0 })
  progress: number;
}

export const EventSchema = SchemaFactory.createForClass(Event);
