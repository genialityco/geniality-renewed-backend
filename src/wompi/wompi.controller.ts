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
import { PaymentPlansService } from 'src/payment-plans/payment-plans.service';

@Controller('wompi')
export class WompiController {
  private readonly logger = new Logger(WompiController.name);

  constructor(
    private wompi: WompiService,
    private prService: PaymentRequestsService,
    private paymentLogs: PaymentLogsService,
    private paymentPlansService: PaymentPlansService,
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

  /**
   * Reporte de reconciliación: obtiene todos los pagos Wompi en el rango
   * indicado y los cruza con PaymentPlans / OrganizationUsers de la org.
   *
   * Query params:
   *   from_date      ISO-8601  (requerido)  ej: 2024-01-01T00:00:00Z
   *   until_date     ISO-8601  (requerido)  ej: 2025-12-31T23:59:59Z
   *   organizationId ObjectId  (requerido)
   *   status         string    (opcional, default APPROVED)
   */
  /**
   * Reporte de reconciliación: obtiene todos los pagos Wompi en el rango
   * indicado y los cruza con PaymentPlans / OrganizationUsers de la org.
   *
   * Query params:
   *   from_date      ISO-8601  (requerido)  ej: 2024-01-01T00:00:00Z
   *   until_date     ISO-8601  (requerido)  ej: 2025-12-31T23:59:59Z
   *   organizationId ObjectId  (requerido)
   *   status         string    (opcional, default APPROVED)
   *   amountCOP      number    (opcional, default 50000) — filtra txs por monto exacto en COP
   */
  @Get('reconcile-report')
  async reconcileReport(
    @Query('from_date') fromDate: string,
    @Query('until_date') untilDate: string,
    @Query('organizationId') organizationId: string,
    @Query('status') status = 'APPROVED',
    @Query('amountCOP') amountCOPRaw = '50000',
  ) {
    if (!fromDate || !untilDate || !organizationId) {
      throw new BadRequestException(
        'from_date, until_date y organizationId son requeridos',
      );
    }

    const amountCents = Math.round(parseFloat(amountCOPRaw) * 100);

    // Traer TODAS las transacciones Wompi del rango (paginación automática)
    const allTransactions: any[] = [];
    const PAGE_SIZE = 50;
    let page = 1;

    while (true) {
      const body = await this.wompi.getTransactions({
        from_date: fromDate,
        until_date: untilDate,
        page,
        page_size: PAGE_SIZE,
        status,
      });

      const items: any[] = Array.isArray(body?.data) ? body.data : [];
      allTransactions.push(...items);

      if (!items.length) break;

      const total = Number(body?.meta?.total_results ?? 0);
      const maxPage = Math.ceil(total / PAGE_SIZE) || page;
      if (page >= maxPage) break;
      page++;
    }

    // Filtrar solo las transacciones con el monto indicado
    const filtered = allTransactions.filter(
      (tx) => tx.amount_in_cents === amountCents,
    );

    await this.paymentLogs.write({
      level: 'info',
      message: 'reconcile-report: transacciones obtenidas y filtradas de Wompi',
      source: 'service',
      organizationId,
      meta: {
        totalFromWompi: allTransactions.length,
        afterAmountFilter: filtered.length,
        amountCOP: amountCOPRaw,
        from_date: fromDate,
        until_date: untilDate,
        status,
      },
    });

    return this.paymentPlansService.reconcileWompiTransactions(
      filtered,
      organizationId,
    );
  }

  /**
   * Clasificación completa de suscripciones cruzada con Wompi.
   * Descarga TODAS las transacciones Wompi desde from_date hasta hoy
   * y las usa como fuente de verdad para clasificar cada usuario.
   *
   * Query params:
   *   organizationId  ObjectId  (requerido)
   *   from_date       ISO-8601  (opcional, default 2023-09-27T00:00:00Z)
   *   amountCOP       number    (opcional, default 50000)
   */
  @Get('full-classification')
  async fullClassification(
    @Query('organizationId') organizationId: string,
    @Query('from_date') fromDate = '2023-01-01T00:00:00Z',
    @Query('amountCOP') amountCOPRaw = '50000',
  ) {
    if (!organizationId) {
      throw new BadRequestException('organizationId es requerido');
    }

    const untilDate = new Date().toISOString();
    const amountCents = Math.round(parseFloat(amountCOPRaw) * 100);

    // Fetch de TODAS las transacciones APPROVED en el rango histórico
    const allTransactions: any[] = [];
    const PAGE_SIZE = 50;
    let page = 1;

    while (true) {
      const body = await this.wompi.getTransactions({
        from_date: fromDate,
        until_date: untilDate,
        page,
        page_size: PAGE_SIZE,
        status: 'APPROVED',
      });

      const items: any[] = Array.isArray(body?.data) ? body.data : [];
      allTransactions.push(...items);

      if (!items.length) break;

      const total = Number(body?.meta?.total_results ?? 0);
      const maxPage = Math.ceil(total / PAGE_SIZE) || page;
      if (page >= maxPage) break;
      page++;
    }

    // Filtrar por monto (membresía)
    const filtered = allTransactions.filter(
      (tx) => tx.amount_in_cents === amountCents,
    );

    await this.paymentLogs.write({
      level: 'info',
      message: 'full-classification: transacciones Wompi obtenidas',
      source: 'service',
      organizationId,
      meta: {
        totalFromWompi: allTransactions.length,
        afterAmountFilter: filtered.length,
        amountCOP: amountCOPRaw,
        from_date: fromDate,
        until_date: untilDate,
      },
    });

    return this.paymentPlansService.getFullSubscriptionClassification(
      filtered,
      organizationId,
    );
  }
}
