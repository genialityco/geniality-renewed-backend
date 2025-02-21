import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

class AccessSettings {
  @Prop() days: number;
  @Prop() price: number;
  @Prop() type: 'free' | 'payment';
}

@Schema({ timestamps: true })
export class Organization extends Document {
  @Prop({ required: true }) name: string;
  @Prop({ type: Types.ObjectId, ref: 'User' }) author: Types.ObjectId;
  @Prop() description: string;
  @Prop({ type: () => AccessSettings }) access_settings: AccessSettings;
  @Prop() visibility: 'PUBLIC' | 'PRIVATE';
}

export const OrganizationSchema = SchemaFactory.createForClass(Organization);
