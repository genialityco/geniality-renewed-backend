import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PaymentRequestDocument = PaymentRequest & Document;

@Schema({ timestamps: true })
export class PaymentRequest {
  @Prop({ required: true, unique: true })
  reference: string;

  @Prop({ required: true })
  userId: string;

  @Prop()
  organizationUserId?: string;

  @Prop({ required: true })
  organizationId: string;

  @Prop({ required: true })
  amount: number;

  @Prop({ default: 'PENDING' })
  status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR';

  @Prop()
  transactionId?: string;

  @Prop({ type: Object })
  rawWebhook?: any;
}

export const PaymentRequestSchema =
  SchemaFactory.createForClass(PaymentRequest);
