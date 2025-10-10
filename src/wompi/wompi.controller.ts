// src/wompi/wompi.controller.ts
import {
  Controller,
  Get,
  Query,
  Param,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { WompiService } from './wompi.service';
import { PaymentRequestsService } from '../payment-requests/payment-requests.service';
import { PaymentLogsService } from 'src/payment-logs/payment-logs.service';

@Controller('wompi')
export class WompiController {
  private readonly logger = new Logger(WompiController.name);

  constructor(
    private wompi: WompiService,
    private prService: PaymentRequestsService,
    private paymentLogs: PaymentLogsService, // ← inyecta logs
  ) {}

  @Get('integrity-signature')
  getIntegritySignature(
    @Query('reference') reference: string,
    @Query('amountInCents') amountInCentsRaw: string,
    @Query('currency') currency = 'COP',
    @Query('expirationTime') expirationTime?: string,
  ) {
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

    const amountInCents = String(parseInt(String(amountInCentsRaw), 10));
    if (!/^\d+$/.test(amountInCents)) {
      throw new BadRequestException(
        'amountInCents debe ser un entero en centavos',
      );
    }

    const cur = String(currency || 'COP').toUpperCase();
    const base = expirationTime
      ? `${reference}${amountInCents}${cur}${expirationTime}${secret}`
      : `${reference}${amountInCents}${cur}${secret}`;
    const signature = createHash('sha256').update(base).digest('hex');

    // Log de auditoría (ligero)
    this.paymentLogs.write({
      level: 'info',
      message: 'integrity-signature generada',
      source: 'service',
      reference,
      amount: Number(amountInCents) / 100,
      currency: cur,
      meta: {
        hasExpirationTime: Boolean(expirationTime),
        env: isProd ? 'prod' : 'test',
      },
    });

    return { signature };
  }

  @Get('transactions/:id/sync')
  async syncByTransaction(@Param('id') id: string) {
    if (!id) throw new BadRequestException('transaction id requerido');

    // Log inicio de poll
    await this.paymentLogs.write({
      level: 'info',
      message: 'poll: inicio',
      source: 'poll',
      transactionId: id,
    });

    const txResp = (await this.wompi.getTransaction(id)) as any;
    const tx = txResp.data;

    // Upsert del PR si no existe
    let pr = await this.prService.findByReference(tx.reference);
    if (!pr) {
      const m = tx.reference?.match?.(/^membresia-([^-\s]+)-([^-\s]+)-/);
      if (m) {
        const [, orgId, uId] = m;
        try {
          pr = await this.prService.create({
            reference: tx.reference,
            userId: uId,
            organizationId: orgId,
            amount: tx.amount_in_cents / 100,
            currency: tx.currency ?? 'COP',
            status: 'CREATED',
            transactionId: tx.id,
          } as any);

          await this.paymentLogs.write({
            level: 'info',
            message: 'poll: PR creado (upsert)',
            source: 'poll',
            reference: tx.reference,
            transactionId: tx.id,
            organizationId: orgId,
            userId: uId,
            amount: tx.amount_in_cents / 100,
            currency: tx.currency ?? 'COP',
          });
        } catch (e) {
          pr = await this.prService.findByReference(tx.reference);
          await this.paymentLogs.write({
            level: 'warn',
            message: 'poll: upsert PR concurrente (releído)',
            source: 'poll',
            reference: tx.reference,
            transactionId: tx.id,
            meta: { error: e?.message },
          });
        }
      } else {
        await this.paymentLogs.write({
          level: 'warn',
          message: 'poll: reference no parseable, no se pudo upsert',
          source: 'poll',
          reference: tx.reference,
          transactionId: tx.id,
        });
      }
    }

    const nextStatus = String(tx.status || '').toUpperCase() as
      | 'CREATED'
      | 'PENDING'
      | 'APPROVED'
      | 'DECLINED'
      | 'VOIDED'
      | 'ERROR';

    const res = await this.prService.safeUpdateStatus({
      reference: tx.reference,
      nextStatus,
      transactionId: tx.id,
      source: 'poll',
      rawWompi: txResp,
    });

    if (!res.doc) {
      await this.paymentLogs.write({
        level: 'error',
        message: 'poll: PR inexistente tras safeUpdateStatus',
        source: 'poll',
        reference: tx.reference,
        transactionId: tx.id,
        status: nextStatus,
      });
      throw new BadRequestException(
        `No existe PaymentRequest con reference ${tx.reference}`,
      );
    }

    // Log del resultado de la transición
    await this.paymentLogs.write({
      level: 'info',
      message: 'poll: estado actualizado',
      source: 'poll',
      reference: res.doc.reference,
      transactionId: res.doc.transactionId,
      status: res.doc.status,
      amount: res.doc.amount,
      currency: res.doc.currency ?? 'COP',
      meta: { becameApproved: res.becameApproved },
    });

    // Activar SIEMPRE que esté APPROVED (idempotente)
    if ((res.doc.status ?? '').toUpperCase() === 'APPROVED') {
      try {
        await this.prService.activateMembershipForPayment(
          res.doc,
          tx.amount_in_cents / 100,
        );

        await this.paymentLogs.write({
          level: 'info',
          message: 'poll: PaymentPlan activado',
          source: 'poll',
          reference: res.doc.reference,
          transactionId: res.doc.transactionId,
          organizationId: res.doc.organizationId,
          userId: String(res.doc.userId),
          amount: tx.amount_in_cents / 100,
          currency: tx.currency ?? 'COP',
        });
      } catch (e) {
        this.logger.warn(
          `activateMembershipForPayment falló en poll: ${tx.reference}`,
          e as any,
        );
        await this.paymentLogs.write({
          level: 'error',
          message: 'poll: fallo activando PaymentPlan',
          source: 'poll',
          reference: res.doc.reference,
          transactionId: res.doc.transactionId,
          organizationId: res.doc.organizationId,
          userId: String(res.doc.userId),
          amount: tx.amount_in_cents / 100,
          currency: tx.currency ?? 'COP',
          meta: { error: (e as any)?.message || String(e) },
        });
      }
    }

    return res.doc;
  }
}
