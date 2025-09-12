import { Module } from '@nestjs/common';
import { WompiService } from './wompi.service';
import { WompiReconcile } from './wompi.reconcile';
import { PaymentRequestsModule } from '../payment-requests/payment-requests.module';
import { WompiController } from './wompi.controller';

@Module({
  imports: [PaymentRequestsModule],
  controllers: [WompiController],
  providers: [WompiService, WompiReconcile],
  exports: [WompiService],
})
export class WompiModule {}
