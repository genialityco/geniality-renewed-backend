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
import { PaymentPlansService } from '../payment-plans/payment-plans.service';

@Injectable()
export class PaymentRequestsService {
  constructor(
    @InjectModel(PaymentRequest.name)
    private paymentRequestModel: Model<PaymentRequestDocument>,

    @InjectModel(OrganizationUser.name)
    private organizationUserModel: Model<OrganizationUser>,

    @InjectModel(PaymentPlan.name)
    private paymentPlanModel: Model<PaymentPlan>,
    private readonly paymentPlansService: PaymentPlansService,
  ) { }

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
    transactionId?: string,
    rawWebhook: any = null,
  ) {
    const $set: any = { status };
    if (transactionId) $set.transactionId = transactionId;
    if (rawWebhook) $set.rawWebhook = rawWebhook;
    return this.paymentRequestModel.findOneAndUpdate(
      { reference },
      { $set },
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
      await this.paymentPlansService.updateDateUntil(
        paymentPlan._id.toString(),
        dateUntil,
        organizationUser.properties?.nombres || 'Usuario',
      );
    } else {
      // Si no tiene, crea uno nuevo
      // paymentPlan = await this.paymentPlanModel.create({
      //   days: MEMBERSHIP_DAYS,
      //   date_until: dateUntil,
      //   price: amount,
      //   organization_user_id: organizationUser._id,
      // });
      await this.paymentPlansService.createPaymentPlan(
        organizationUser._id.toString(),
        MEMBERSHIP_DAYS,
        dateUntil,
        amount,
        organizationUser.properties?.nombres || 'Usuario',
      );
    }

    // 3. Asociar el PaymentPlan al organizationUser
    organizationUser.payment_plan_id = paymentPlan._id as unknown as string;
    await organizationUser.save();
  }

  // src/payment-requests/payment-requests.service.ts
  async safeUpdateStatus({
    reference,
    nextStatus,
    transactionId,
    source,
    rawWebhook,
  }: {
    reference: string;
    nextStatus:
    | 'CREATED'
    | 'PENDING'
    | 'APPROVED'
    | 'DECLINED'
    | 'VOIDED'
    | 'ERROR';
    transactionId?: string;
    source: 'webhook' | 'poll' | 'redirect';
    rawWebhook?: any;
  }) {
    const current = await this.paymentRequestModel.findOne({ reference });
    if (!current) return null;

    // si ya está en APPROVED y llega algo repetido, no dispares efectos otra vez
    if (current.status === 'APPROVED' && nextStatus !== 'APPROVED')
      return current;

    current.status_history = current.status_history || [];
    current.status_history.push({
      at: new Date(),
      from: current.status,
      to: nextStatus,
      source,
    });

    current.status = nextStatus;
    if (transactionId) current.transactionId = transactionId;
    if (rawWebhook) current.rawWebhook = rawWebhook;
    await current.save();
    return current;
  }

  async listStalePendings(staleMinutes = 10, limit = 200) {
    const since = new Date(Date.now() - staleMinutes * 60 * 1000);
    // Necesitas timestamps en el schema: { timestamps: true }
    return this.paymentRequestModel
      .find({
        status: { $in: ['CREATED', 'PENDING'] },
        updatedAt: { $lt: since },
      })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .lean();
  }
}
