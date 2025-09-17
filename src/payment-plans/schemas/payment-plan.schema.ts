// payment-plans/schemas/payment-plan.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

@Schema({ timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } })
export class PaymentPlan extends Document {
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
  })
  organization_user_id: string;

  // --- NUEVO: para rastrear origen y estados ---
  @Prop({ enum: ['gateway', 'manual', 'admin'], default: 'manual' })
  source: 'gateway' | 'manual' | 'admin';

  @Prop({ type: [Object], default: [] })
  status_history: any[];

  // metadatos opcionales para auditoría / conciliación
  @Prop()
  reference?: string;

  @Prop()
  transactionId?: string;

  @Prop({ default: 'COP' })
  currency?: string;

  @Prop({ type: Object })
  rawWebhook?: any;
}

export const PaymentPlanSchema = SchemaFactory.createForClass(PaymentPlan);
