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
} from '@nestjs/common';
import { PaymentRequestsService } from './payment-requests.service';
import { WompiWebhookGuard } from 'src/wompi/wompi-webhook.guard';

@Controller('payment-requests')
export class PaymentRequestsController {
  constructor(private readonly service: PaymentRequestsService) {}

  // 1. Registrar un nuevo intento de pago
  @Post()
  async create(@Body() body: any) {
    // Espera: { reference, userId, organizationUserId, organizationId, amount }
    return this.service.create(body);
  }

  // 2. Consultar el estado de un intento de pago
  @Get('by-reference/:reference')
  async getByReference(@Param('reference') reference: string) {
    return this.service.findByReference(reference);
  }

  @Get('by-transaction/:transactionId')
  async getByTransactionId(@Param('transactionId') transactionId: string) {
    return this.service.findByTransactionId(transactionId);
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
    return this.service.search({
      organizationId,
      q: q?.trim(),
      status: status?.trim(),
      page,
      pageSize,
      dateFrom,
      dateTo,
    });
  }

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
    const pr = await this.service.findByReference(reference);
    if (!pr) return { ok: true };

    // Defensa adicional
    if (pr.amount * 100 !== amount_in_cents) {
      /* log discrepancy */
    }
    if (pr.currency && pr.currency !== currency) {
      /* log discrepancy */
    }

    const res = await this.service.safeUpdateStatus({
      reference,
      nextStatus: status,
      transactionId,
      source: 'webhook',
      rawWompi: {
        // guarda algo útil y “crudo”
        headers: undefined,
        event: body?.event,
        signature: body?.signature,
        transaction: tx,
      },
    });

    if (res.becameApproved && res.doc) {
      await this.service.activateMembershipForPayment(
        res.doc,
        amount_in_cents / 100,
      );
    }
    return { ok: true };
  }

  @Post(':reference/link-transaction')
  async linkTx(
    @Param('reference') reference: string,
    @Body() dto: { transactionId: string },
  ) {
    const pr = await this.service.findByReference(reference);
    if (!pr) throw new NotFoundException('PR no encontrado');

    if (!pr.transactionId) {
      await this.service.updateStatusAndTransactionId(
        reference,
        pr.status,
        dto.transactionId,
      );
    }
    return { ok: true };
  }
}
