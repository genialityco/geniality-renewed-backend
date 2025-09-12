import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PaymentRequestDocument = PaymentRequest & Document;

@Schema({ timestamps: true })
export class PaymentRequest {
  @Prop({ required: true, unique: true, index: true })
  reference: string;

  @Prop({ required: true })
  userId: string;

  @Prop()
  organizationUserId?: string;

  @Prop({ required: true })
  organizationId: string;

  @Prop({ required: true })
  amount: number;

  @Prop({ default: 'CREATED' })
  status: 'CREATED' | 'PENDING' | 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR';

  @Prop({ type: [Object], default: [] })
  status_history: any[];

  @Prop({ unique: true, sparse: true })
  transactionId?: string;

  @Prop({ default: 'COP' })
  currency: string;

  @Prop({ type: Object })
  rawWebhook?: any;
}

export const PaymentRequestSchema =
  SchemaFactory.createForClass(PaymentRequest);
