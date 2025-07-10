import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  PaymentRequest,
  PaymentRequestDocument,
} from './schemas/payment-request.schema';

// Importa tus modelos
import { OrganizationUser } from '../organization-users/schemas/organization-user.schema';
import { PaymentPlan } from '../payment-plans/schemas/payment-plan.schema';

@Injectable()
export class PaymentRequestsService {
  constructor(
    @InjectModel(PaymentRequest.name)
    private paymentRequestModel: Model<PaymentRequestDocument>,

    @InjectModel(OrganizationUser.name)
    private organizationUserModel: Model<OrganizationUser>,

    @InjectModel(PaymentPlan.name)
    private paymentPlanModel: Model<PaymentPlan>,
  ) {}

  async create(data: Partial<PaymentRequest>): Promise<PaymentRequest> {
    return this.paymentRequestModel.create(data);
  }

  async findByReference(reference: string): Promise<PaymentRequest | null> {
    return this.paymentRequestModel.findOne({ reference });
  }

  async findByTransactionId(
    transactionId: string,
  ): Promise<PaymentRequest | null> {
    return this.paymentRequestModel.findOne({ transactionId });
  }

  async updateStatusAndTransactionId(
    reference: string,
    status: string,
    transactionId: string,
    rawWebhook: any = null,
  ) {
    return this.paymentRequestModel.findOneAndUpdate(
      { reference },
      { status, transactionId, ...(rawWebhook ? { rawWebhook } : {}) },
      { new: true },
    );
  }

  /**
   * Crea o actualiza el PaymentPlan para el usuario tras un pago aprobado.
   * Asocia el paymentPlan al organizationUser correspondiente.
   */
  async activateMembershipForPayment(
    paymentRequest: PaymentRequest,
    amount: number,
  ) {
    const MEMBERSHIP_DAYS = 365;
    const now = new Date();
    const dateUntil = new Date(
      now.getTime() + MEMBERSHIP_DAYS * 24 * 60 * 60 * 1000,
    );

    // 1. Buscar organizationUser por user_id (como ObjectId)
    const userObjectId =
      typeof paymentRequest.userId === 'string'
        ? new Types.ObjectId(paymentRequest.userId)
        : paymentRequest.userId;

    const organizationUser = await this.organizationUserModel.findOne({
      user_id: userObjectId,
    });

    if (!organizationUser) throw new Error('OrganizationUser no encontrado');

    // 2. Buscar si ya tiene un PaymentPlan activo
    let paymentPlan = await this.paymentPlanModel.findOne({
      organization_user_id: organizationUser._id,
    });

    if (paymentPlan) {
      // Si ya tiene, actualiza la fecha hasta
      paymentPlan.date_until = dateUntil;
      paymentPlan.price = amount;
      await paymentPlan.save();
    } else {
      // Si no tiene, crea uno nuevo
      paymentPlan = await this.paymentPlanModel.create({
        days: MEMBERSHIP_DAYS,
        date_until: dateUntil,
        price: amount,
        organization_user_id: organizationUser._id,
      });
    }

    // 3. Asociar el PaymentPlan al organizationUser
    organizationUser.payment_plan_id = paymentPlan._id as unknown as string;
    await organizationUser.save();

    // (Opcional) Actualiza el estado del PaymentRequest si necesitas
    await this.updateStatusAndTransactionId(
      paymentRequest.reference,
      'APPROVED',
      paymentRequest.transactionId,
    );
  }
}
