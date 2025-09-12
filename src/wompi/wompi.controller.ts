// src/wompi/wompi.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { createHash } from 'crypto';
import { Param } from '@nestjs/common';
import { WompiService } from './wompi.service';
import { PaymentRequestsService } from '../payment-requests/payment-requests.service';

@Controller('wompi')
export class WompiController {
  @Get('integrity-signature')
  getIntegritySignature(
    @Query('reference') reference: string,
    @Query('amountInCents') amountInCents: string,
    @Query('currency') currency = 'COP',
    @Query('expirationTime') expirationTime?: string,
  ) {
    const secret = process.env.WOMPI_INTEGRITY_SECRET!;
    const base = expirationTime
      ? `${reference}${amountInCents}${currency}${expirationTime}${secret}`
      : `${reference}${amountInCents}${currency}${secret}`;
    const signature = createHash('sha256').update(base).digest('hex');
    return { signature };
  }

  constructor(
    private wompi: WompiService,
    private prService: PaymentRequestsService,
  ) {}

  @Get('transactions/:id/sync')
  async syncByTransaction(@Param('id') id: string) {
    const response = (await this.wompi.getTransaction(id)) as { data: any };
    const tx = response.data;
    const updated = await this.prService.safeUpdateStatus({
      reference: tx.reference,
      nextStatus: tx.status,
      transactionId: tx.id,
      source: 'poll',
    });
    if (tx.status === 'APPROVED') {
      await this.prService.activateMembershipForPayment(
        updated,
        tx.amount_in_cents / 100,
      );
    }
    return updated;
  }
}
