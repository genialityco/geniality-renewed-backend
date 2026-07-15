// src/organizations/schemas/organization.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, Schema as MongooseSchema } from 'mongoose';

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
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  user_properties: any[];
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  styles?: { banner_image_email?: string; FooterImage?: string; banner_image?: string; event_image?: string; logo_image?: string };
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  tab_titles?: { courses?: string; activities?: string; exclusive?: string };
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  welcome_email?: {
    enabled?: boolean;
    subject?: string;
    title?: string;
    body?: string;
  };
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  subscription_created_email?: {
    enabled?: boolean;
    subject?: string;
    title?: string;
    body?: string;
  };
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  subscription_updated_email?: {
    enabled?: boolean;
    subject?: string;
    title?: string;
    body?: string;
  };
}

export const OrganizationSchema = SchemaFactory.createForClass(Organization);
