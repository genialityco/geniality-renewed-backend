import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  UseGuards,
  NotFoundException,
  BadRequestException,
  Query,
  Logger,
} from '@nestjs/common';
import { PaymentRequestsService } from './payment-requests.service';
import { WompiWebhookGuard } from 'src/wompi/wompi-webhook.guard';
import { PaymentLogsService } from 'src/payment-logs/payment-logs.service';

@Controller('payment-requests')
export class PaymentRequestsController {
  constructor(
    private readonly prService: PaymentRequestsService,
    private readonly paymentLogs: PaymentLogsService, // ← inyecta logs
  ) {}

  // 1) Registrar un nuevo intento de pago (desde frontend)
  @Post()
  async create(@Body() body: any) {
    // Espera: { reference, userId, organizationUserId, organizationId, amount, currency? }
    const pr = await this.prService.create(body);

    // Log de creación de intento
    await this.paymentLogs.write({
      level: 'info',
      message: 'PaymentRequest creado controller',
      source: 'frontend',
      reference: body.reference,
      transactionId: body.transactionId,
      organizationId: body.organizationId,
      userId: body.userId,
      amount: body.amount,
      currency: body.currency ?? 'COP',
    });

    return pr;
  }

  // 2) Consultar el estado por referencia (para panel/admin)
  @Get('by-reference/:reference')
  async getByReference(@Param('reference') reference: string) {
    const pr = await this.prService.findByReference(reference);
    await this.paymentLogs.write({
      level: 'info',
      message: 'Consulta por referencia',
      source: 'service',
      reference,
      status: pr?.status,
    });
    return pr;
  }

  @Get('by-transaction/:transactionId')
  async getByTransactionId(@Param('transactionId') transactionId: string) {
    const pr = await this.prService.findByTransactionId(transactionId);
    await this.paymentLogs.write({
      level: 'info',
      message: 'Consulta por transactionId',
      source: 'service',
      reference: pr?.reference,
      transactionId,
      status: pr?.status,
    });
    return pr;
  }

  @Get('search')
  async search(
    @Query('organizationId') organizationId: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    if (!organizationId) {
      throw new BadRequestException('organizationId requerido');
    }
    const page = Math.max(1, Number(pageRaw || 1));
    const pageSize = Math.min(100, Math.max(1, Number(pageSizeRaw || 20)));
    const res = await this.prService.search({
      organizationId,
      q: q?.trim(),
      status: status?.trim(),
      page,
      pageSize,
      dateFrom,
      dateTo,
    });

    await this.paymentLogs.write({
      level: 'info',
      message: 'Búsqueda de payment-requests',
      source: 'service',
      organizationId,
      meta: { q, status, page, pageSize, dateFrom, dateTo, total: res.total },
    });

    return res;
  }

  // 3) Webhook de Wompi (A: upsert PR + B: activar si APPROVED)
  @Post('webhook')
  @UseGuards(WompiWebhookGuard)
  async wompiWebhook(@Body() body: any) {
    const tx = body.data?.transaction;
    if (!tx) return { ok: true };

    const {
      reference,
      status,
      id: transactionId,
      amount_in_cents,
      currency,
    } = tx;

    // Log ingreso webhook
    await this.paymentLogs.write({
      level: 'info',
      message: 'Webhook recibido',
      source: 'webhook',
      reference,
      transactionId,
      status,
      amount: amount_in_cents / 100,
      currency,
      meta: { event: body?.event },
    });

    let pr = await this.prService.findByReference(reference);
    if (!pr) {
      const m = reference?.match?.(/^membresia-([^-\s]+)-([^-\s]+)-/);
      if (m) {
        const [, orgId, uId] = m;
        try {
          pr = await this.prService.create({
            reference,
            userId: uId,
            organizationId: orgId,
            amount: amount_in_cents / 100,
            currency,
            status: 'CREATED',
            transactionId, // si viene
          } as any);

          await this.paymentLogs.write({
            level: 'info',
            message: 'PaymentRequest upsert por webhook',
            source: 'webhook',
            reference,
            transactionId,
            organizationId: orgId,
            userId: uId,
          });
        } catch (e) {
          Logger.debug(`Error creando PR desde webhook: ${e.message}`);
          pr = await this.prService.findByReference(reference);
          await this.paymentLogs.write({
            level: 'warn',
            message: 'Upsert PR por webhook: E11000 o carrera, se releyó PR',
            source: 'webhook',
            reference,
            transactionId,
            meta: { error: e?.message },
          });
        }
      } else {
        await this.paymentLogs.write({
          level: 'warn',
          message: 'Webhook con reference no parseable',
          source: 'webhook',
          reference,
          transactionId,
        });
      }
    }

    const nextStatus = String(status || '').toUpperCase() as
      | 'CREATED'
      | 'PENDING'
      | 'APPROVED'
      | 'DECLINED'
      | 'VOIDED'
      | 'ERROR';

    const res = await this.prService.safeUpdateStatus({
      reference,
      nextStatus,
      transactionId,
      source: 'webhook',
      rawWompi: {
        event: body?.event,
        signature: body?.signature,
        transaction: tx,
      },
    });

    await this.paymentLogs.write({
      level: 'info',
      message: 'Webhook procesado',
      source: 'webhook',
      reference,
      transactionId,
      status: res.doc?.status,
    });

    // Activar SIEMPRE que el PR esté en APPROVED (idempotente)
    if ((res.doc?.status ?? '').toUpperCase() === 'APPROVED') {
      try {
        await this.prService.activateMembershipForPayment(
          res.doc,
          amount_in_cents / 100,
        );

        await this.paymentLogs.write({
          level: 'info',
          message: 'PaymentPlan activado por webhook',
          source: 'webhook',
          reference,
          transactionId,
          organizationId: res.doc.organizationId,
          userId: String(res.doc.userId),
          amount: amount_in_cents / 100,
          currency: currency ?? 'COP',
        });
      } catch (e) {
        Logger.warn(`activateMembershipForPayment falló: ${reference}`, e);
        await this.paymentLogs.write({
          level: 'error',
          message: 'Fallo activando PaymentPlan (webhook)',
          source: 'webhook',
          reference,
          transactionId,
          organizationId: res.doc?.organizationId,
          userId: String(res.doc?.userId || ''),
          amount: amount_in_cents / 100,
          currency: currency ?? 'COP',
          meta: { error: e?.message || String(e) },
        });
      }
    }
    return { ok: true };
  }

  // 4) Link manual de transactionId (desde redirect UI)
  @Post(':reference/link-transaction')
  async linkTx(
    @Param('reference') reference: string,
    @Body() dto: { transactionId: string },
  ) {
    const pr = await this.prService.findByReference(reference);
    if (!pr) {
      await this.paymentLogs.write({
        level: 'warn',
        message: 'LinkTx: PR no encontrado',
        source: 'service',
        reference,
        transactionId: dto.transactionId,
      });
      throw new NotFoundException('PR no encontrado');
    }

    if (!pr.transactionId) {
      await this.prService.updateStatusAndTransactionId(
        reference,
        pr.status,
        dto.transactionId,
      );

      await this.paymentLogs.write({
        level: 'info',
        message: 'TransactionId enlazado',
        source: 'service',
        reference,
        transactionId: dto.transactionId,
        status: pr.status,
      });
    } else {
      await this.paymentLogs.write({
        level: 'warn',
        message: 'LinkTx omitido (ya tenía transactionId)',
        source: 'service',
        reference,
        transactionId: pr.transactionId,
        status: pr.status,
      });
    }
    return { ok: true };
  }
}
