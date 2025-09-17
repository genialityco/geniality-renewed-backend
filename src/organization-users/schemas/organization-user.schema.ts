import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, Document, Schema as MongooseSchema } from 'mongoose';

@Schema({ timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } })
export class OrganizationUser extends Document {
  _id: Types.ObjectId;

  // Deja properties como un objeto libre
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  properties: any;

  @Prop({ required: false, default: null })
  rol_id: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  })
  organization_id: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  user_id: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'PaymentPlan' })
  payment_plan_id?: string;
}

export const OrganizationUserSchema =
  SchemaFactory.createForClass(OrganizationUser);
