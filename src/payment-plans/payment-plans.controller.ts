import { Controller, Get, Param, Post, Body, Patch } from '@nestjs/common';
import { PaymentPlansService } from './payment-plans.service';
import { OrganizationUsersService } from '../organization-users/organization-users.service';
import { PaymentPlan } from './schemas/payment-plan.schema';

@Controller('payment-plans')
export class PaymentPlansController {
  constructor(
    private readonly paymentPlansService: PaymentPlansService,
    private readonly organizationUsersService: OrganizationUsersService,
  ) {}

  // Endpoint existente para validar acceso...
  @Get('validate/:organizationUserId')
  async validateAccess(
    @Param('organizationUserId') organizationUserId: string,
  ): Promise<{ access: boolean }> {
    const access =
      await this.paymentPlansService.isUserAccessValid(organizationUserId);
    return { access };
  }

  // Endpoint para obtener el PaymentPlan a partir del userId
  @Get('by-user/:userId')
  async getPlanByUserId(@Param('userId') userId: string): Promise<PaymentPlan> {
    const organizationUser =
      await this.organizationUsersService.findByUserId(userId);
    const plan =
      await this.paymentPlansService.getPaymentPlanByOrganizationUserId(
        organizationUser._id.toString(),
      );
    return plan;
  }

  // Nuevo endpoint para crear un PaymentPlan sin usar DTO
  @Post()
  async createPaymentPlan(@Body() body: any): Promise<PaymentPlan> {
    const {
      organization_user_id,
      days,
      date_until,
      price,
      source,
      status_history,
      reference,
      transactionId,
      currency,
      rawWebhook,
      nameUser,
      payment_request_id,
    } = body;

    return this.paymentPlansService.createPaymentPlan(
      organization_user_id,
      days,
      new Date(date_until),
      price,
      nameUser,
      {
        source,
        status_history,
        reference,
        transactionId,
        currency,
        rawWebhook,
        payment_request_id,
      },
    );
  }

  // PATCH /payment-plans/:id/date-until
  @Patch(':id/date-until')
  async updateDateUntil(
    @Param('id') paymentPlanId: string,
    @Body('date_until') date_until: string,
    @Body('nameUser') nameUser: string,
    @Body('source') source?: string,
  ): Promise<PaymentPlan> {
    return this.paymentPlansService.updateDateUntil(
      paymentPlanId,
      new Date(date_until),
      nameUser,
      source,
    );
  }

  // DELETE /payment-plans/:id
  @Post(':id/delete')
  async deletePaymentPlan(
    @Param('id') paymentPlanId: string,
  ): Promise<{ message: string }> {
    await this.paymentPlansService.deletePaymentPlan(paymentPlanId);
    return { message: 'PaymentPlan eliminado exitosamente' };
  }
}
