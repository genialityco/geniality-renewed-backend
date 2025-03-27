import { Controller, Get, Param, Post, Body } from '@nestjs/common';
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
    const { organizationUserId, days, date_until, price } = body;
    return this.paymentPlansService.createPaymentPlan(
      organizationUserId,
      days,
      new Date(date_until),
      price,
    );
  }
}
