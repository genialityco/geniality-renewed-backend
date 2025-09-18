// src/wompi/wompi.controller.ts
import {
  Controller,
  Get,
  Query,
  Param,
  BadRequestException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { WompiService } from './wompi.service';
import { PaymentRequestsService } from '../payment-requests/payment-requests.service';

@Controller('wompi')
export class WompiController {
  constructor(
    private wompi: WompiService,
    private prService: PaymentRequestsService,
  ) {}

  @Get('integrity-signature')
  getIntegritySignature(
    @Query('reference') reference: string,
    @Query('amountInCents') amountInCentsRaw: string,
    @Query('currency') currency = 'COP',
    @Query('expirationTime') expirationTime?: string, // ISO8601 opcional
  ) {
    // Elegir secreto por entorno
    const isProd = process.env.WOMPI_ENV === 'production';
    const secret = isProd
      ? process.env.WOMPI_INTEGRITY_SECRET_PROD
      : process.env.WOMPI_INTEGRITY_SECRET_TEST;

    if (!secret) {
      throw new Error(
        'WOMPI_INTEGRITY_SECRET no configurado para el entorno actual',
      );
    }
    if (!reference) throw new BadRequestException('reference es requerido');
    if (!amountInCentsRaw)
      throw new BadRequestException('amountInCents es requerido');

    // Normalizar amountInCents (entero en centavos, sin separadores)
    const amountInCents = String(parseInt(String(amountInCentsRaw), 10));
    if (!/^\d+$/.test(amountInCents)) {
      throw new BadRequestException(
        'amountInCents debe ser un entero en centavos',
      );
    }

    const cur = String(currency || 'COP').toUpperCase();

    // Cadena base (respeta exactamente el orden de Wompi)
    const base = expirationTime
      ? `${reference}${amountInCents}${cur}${expirationTime}${secret}`
      : `${reference}${amountInCents}${cur}${secret}`;

    const signature = createHash('sha256').update(base).digest('hex');
    return { signature };
  }

  @Get('transactions/:id/sync')
  async syncByTransaction(@Param('id') id: string) {
    if (!id) throw new BadRequestException('transaction id requerido');

    const { data: tx } = (await this.wompi.getTransaction(id)) as any;

    const res = await this.prService.safeUpdateStatus({
      reference: tx.reference,
      nextStatus: tx.status,
      transactionId: tx.id,
      source: 'poll',
    });

    if (!res.doc) {
      throw new BadRequestException(
        `No existe PaymentRequest con reference ${tx.reference}`,
      );
    }

    // Solo activa si la transición a APPROVED ocurrió AHORA
    if (res.becameApproved) {
      await this.prService.activateMembershipForPayment(
        res.doc,
        tx.amount_in_cents / 100,
      );
    }

    return res.doc;
  }
}
