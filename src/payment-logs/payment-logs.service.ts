import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PaymentLog, PaymentLogDocument } from './schemas/payment-log.schema';

type Level = 'info' | 'warn' | 'error';

@Injectable()
export class PaymentLogsService {
  constructor(
    @InjectModel(PaymentLog.name)
    private model: Model<PaymentLogDocument>,
  ) {}

  async write(entry: {
    level: Level;
    message: string;
    reference?: string;
    transactionId?: string;
    organizationId?: string;
    userId?: string;
    source?:
      | 'frontend'
      | 'webhook'
      | 'poll'
      | 'reconcile'
      | 'service'
      | 'wompi-api';
    status?: string;
    amount?: number;
    currency?: string;
    meta?: any;
  }) {
    try {
      await this.model.create(entry);
    } catch (e) {
      // No romper flujos por fallos de log
      console.error('Persist log failed', e);
    }
  }
}
