// payment-plans.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PaymentPlan } from './schemas/payment-plan.schema';
import { OrganizationUser } from '../organization-users/schemas/organization-user.schema'; // Ajusta la ruta según tu estructura
import { EmailService } from '../email/email.service'; // Ajusta la ruta
import { renderSubscriptionContent } from '../templates/PaySuscription';

type PlanMeta = {
  source?: 'gateway' | 'manual' | 'admin';
  status_history?: any[];
  reference?: string;
  transactionId?: string;
  currency?: string;
  rawWebhook?: any;
};

@Injectable()
export class PaymentPlansService {
  constructor(
    @InjectModel(PaymentPlan.name)
    private paymentPlanModel: Model<PaymentPlan>,
    @InjectModel(OrganizationUser.name)
    private organizationUserModel: Model<OrganizationUser>,
    private readonly emailService: EmailService,
  ) { }

  // Método para obtener el email a partir del organizationUserId
  private async getEmailByOrganizationUserId(
    organizationUserId: string,
  ): Promise<string | null> {
    const orgUser = await this.organizationUserModel
      .findById(organizationUserId)
      .exec();
    return orgUser?.properties?.email || null;
  }

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
    UserName?: string,
    meta?: PlanMeta, // ← NUEVO
  ): Promise<PaymentPlan> {
    const newPlan = new this.paymentPlanModel({
      organization_user_id: organizationUserId,
      days,
      date_until,
      price,
      source: meta?.source ?? 'manual',
      status_history: meta?.status_history ?? [],
      reference: meta?.reference,
      transactionId: meta?.transactionId,
      currency: meta?.currency ?? 'COP',
      rawWebhook: meta?.rawWebhook,
    });

    const plan = await newPlan.save();

    const email = await this.getEmailByOrganizationUserId(organizationUserId);
    if (email) {
      const html = renderSubscriptionContent({
        dateUntil: date_until,
        variant: 'created',
        nameUser: UserName,
      });
      const Subject = '¡Gracias por tu suscripción a EndoCampus!';
      await this.emailService.sendLayoutEmail(
        email,
        Subject,
        html,
        organizationUserId,
      );
    }
    return plan;
  }

  // Nuevo método para actualizar date_until de un PaymentPlan
  async updateDateUntil(
    paymentPlanId: string,
    date_until: Date,
    nameUser: string,
  ): Promise<PaymentPlan> {
    const plan = await this.paymentPlanModel.findByIdAndUpdate(
      paymentPlanId,
      { date_until },
      { new: true },
    );
    if (!plan) {
      throw new NotFoundException('PaymentPlan no encontrado');
    }
    // ENVÍA EMAIL: Actualizó la suscripción
    const email = await this.getEmailByOrganizationUserId(
      plan.organization_user_id,
    );
    if (email) {
      // await this.emailService.sendEmail(
      //   email,
      //   'Actualizó la suscripción',
      //   `<p>Has actualizado la vigencia de tu suscripción. Ahora tienes acceso hasta el <b>${date_until.toLocaleDateString()}</b>.</p>`,
      // );
      const html = renderSubscriptionContent({
        dateUntil: date_until,
        variant: 'updated',
        nameUser: nameUser,
      });
      const Subject = '¡Tu suscripción fue actualizada!';
      await this.emailService.sendLayoutEmail(
        email,
        Subject, // subject
        html,
        plan.organization_user_id, // Opcional: para usar el layout de la organización
      );
    }
    return plan;
  }
  // Nuevo método para eliminar un PaymentPlan
  async deletePaymentPlan(paymentPlanId: string): Promise<void> {
    const deleted = await this.paymentPlanModel.findByIdAndDelete(paymentPlanId).exec();
    if (!deleted) {
      throw new NotFoundException('PaymentPlan no encontrado');
    }
  }
}
