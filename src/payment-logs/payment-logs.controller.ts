import { Controller, Get, Param, Query } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PaymentLog, PaymentLogDocument } from './schemas/payment-log.schema';

@Controller('payment-logs')
export class PaymentLogsController {
  constructor(
    @InjectModel(PaymentLog.name)
    private model: Model<PaymentLogDocument>,
  ) {}

  // GET /payment-logs/by-reference/:reference?limit=50
  @Get('by-reference/:reference')
  async byReference(
    @Param('reference') reference: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Math.min(200, Math.max(1, Number(limitRaw || 50)));
    return this.model
      .find({ reference })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
  }

  // GET /payment-logs/by-transaction/:txId?limit=50
  @Get('by-transaction/:txId')
  async byTransaction(
    @Param('txId') txId: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Math.min(200, Math.max(1, Number(limitRaw || 50)));
    return this.model
      .find({ transactionId: txId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
  }
}
