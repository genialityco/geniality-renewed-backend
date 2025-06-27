// payment-plans.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PaymentPlan } from './schemas/payment-plan.schema';

@Injectable()
export class PaymentPlansService {
  constructor(
    @InjectModel(PaymentPlan.name)
    private paymentPlanModel: Model<PaymentPlan>,
  ) {}

  // Método para obtener el plan de pago de una organización (o usuario) por su ID
  async getPaymentPlanByOrganizationUserId(
    organizationUserId: string,
  ): Promise<PaymentPlan> {
    const plan = await this.paymentPlanModel
      .findOne({ organization_user_id: organizationUserId })
      .exec();
    if (!plan) {
      throw new NotFoundException('Plan de pago no encontrado para el usuario');
    }
    return plan;
  }

  // Método para validar el acceso de un usuario/organización según su plan de pago
  async isUserAccessValid(organizationUserId: string): Promise<boolean> {
    const plan = await this.paymentPlanModel
      .findOne({ organization_user_id: organizationUserId })
      .exec();
    if (!plan) {
      // Si no se encontró un plan, se niega el acceso
      return false;
    }
    const currentDate = new Date();
    // Se valida que la fecha actual sea menor o igual a la fecha de expiración del plan
    return currentDate <= new Date(plan.date_until);
  }

  // Nuevo método para crear un PaymentPlan
  async createPaymentPlan(
    organizationUserId: string,
    days: number,
    date_until: Date,
    price: number,
  ): Promise<PaymentPlan> {
    const newPlan = new this.paymentPlanModel({
      organization_user_id: organizationUserId,
      days,
      date_until,
      price,
    });
    return newPlan.save();
  }

  // Nuevo método para actualizar date_until de un PaymentPlan
  async updateDateUntil(
    paymentPlanId: string,
    date_until: Date,
  ): Promise<PaymentPlan> {
    const plan = await this.paymentPlanModel.findByIdAndUpdate(
      paymentPlanId,
      { date_until },
      { new: true },
    );
    if (!plan) {
      throw new NotFoundException('PaymentPlan no encontrado');
    }
    return plan;
  }
}
