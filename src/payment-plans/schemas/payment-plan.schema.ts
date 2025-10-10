// payment-plans/schemas/payment-plan.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

@Schema({ timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } })
export class PaymentPlan {
  _id: Types.ObjectId;

  @Prop({ required: true })
  days: number;

  @Prop({ required: true })
  date_until: Date;

  @Prop({ required: true })
  price: number;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'OrganizationUser',
    required: true,
    unique: true,
  })
  organization_user_id: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'PaymentRequest',
    index: true,
  })
  payment_request_id?: Types.ObjectId;

  @Prop({ type: String, enum: ['gateway', 'manual', 'admin'] })
  source: 'gateway' | 'manual' | 'admin';

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  status_history: unknown[];

  @Prop()
  reference?: string;

  @Prop()
  transactionId?: string;

  @Prop({ default: 'COP' })
  currency?: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  rawWebhook?: unknown;
}

export type PaymentPlanDocument = HydratedDocument<PaymentPlan>;
export const PaymentPlanSchema = SchemaFactory.createForClass(PaymentPlan);
