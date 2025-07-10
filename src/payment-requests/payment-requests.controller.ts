import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { PaymentRequestsService } from './payment-requests.service';

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

  @Post('webhook')
  async wompiWebhook(@Body() body: any) {
    // Aquí asumimos el payload estándar de Wompi
    const transaction = body.data?.transaction;
    if (!transaction) return { ok: false };

    const reference = transaction.reference;
    const status = transaction.status; // APPROVED, DECLINED, VOIDED, PENDING, ERROR
    const transactionId = transaction.id;
    const amount = transaction.amount_in_cents
      ? transaction.amount_in_cents / 100
      : undefined;

    // Busca el PaymentRequest por reference
    const paymentRequest = await this.service.findByReference(reference);
    if (!paymentRequest) return { ok: false, msg: 'No paymentRequest found' };

    // Actualiza estado y transactionId
    await this.service.updateStatusAndTransactionId(
      reference,
      status,
      transactionId,
      body,
    );

    // Si fue aprobado, crea/actualiza el PaymentPlan y enlaza a OrganizationUser
    if (status === 'APPROVED') {
      // Llama al servicio encargado de esto (puede estar en otro service/module)
      // Ejemplo:
      await this.service.activateMembershipForPayment(paymentRequest, amount);
    }

    return { ok: true };
  }
}
