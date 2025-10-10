// src/payment-logs/schemas/payment-log.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as M, Types } from 'mongoose';

export type PaymentLogDocument = HydratedDocument<PaymentLog>;

@Schema({ timestamps: true, collection: 'paymentlogs' })
export class PaymentLog {
  _id: Types.ObjectId;

  // Recomendado: valida por enum a nivel de schema
  @Prop({ required: true, enum: ['info', 'warn', 'error'] })
  level: 'info' | 'warn' | 'error';

  @Prop({ required: true })
  message: string;

  @Prop({ index: true }) reference?: string;
  @Prop({ index: true }) transactionId?: string;
  @Prop({ index: true }) organizationId?: string;
  @Prop({ index: true }) userId?: string;

  @Prop({
    enum: [
      'frontend',
      'webhook',
      'poll',
      'reconcile',
      'service',
      'redirect',
      'wompi-api',
    ],
  })
  source?:
    | 'frontend'
    | 'webhook'
    | 'poll'
    | 'reconcile'
    | 'service'
    | 'redirect'
    | 'wompi-api';

  @Prop() status?: string;
  @Prop() amount?: number;
  @Prop() currency?: string;

  @Prop({ type: M.Types.Mixed })
  meta?: any;
}

export const PaymentLogSchema = SchemaFactory.createForClass(PaymentLog);

// Índices útiles
PaymentLogSchema.index({ reference: 1, createdAt: -1 });
PaymentLogSchema.index({ transactionId: 1, createdAt: -1 });
PaymentLogSchema.index({ organizationId: 1, createdAt: -1 });
PaymentLogSchema.index({ userId: 1, createdAt: -1 });
