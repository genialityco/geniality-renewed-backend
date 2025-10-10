import { Module } from '@nestjs/common';
import { WompiService } from './wompi.service';
import { WompiReconcile } from './wompi.reconcile';
import { PaymentRequestsModule } from '../payment-requests/payment-requests.module';
import { WompiController } from './wompi.controller';
import { PaymentLogsService } from 'src/payment-logs/payment-logs.service';
import { MongooseModule } from '@nestjs/mongoose';
import {
  PaymentLog,
  PaymentLogSchema,
} from 'src/payment-logs/schemas/payment-log.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PaymentLog.name, schema: PaymentLogSchema },
    ]),
    PaymentRequestsModule,
  ],
  controllers: [WompiController],
  providers: [WompiService, WompiReconcile, PaymentLogsService],
  exports: [WompiService],
})
export class WompiModule {}
