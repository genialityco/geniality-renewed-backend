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

type SearchParams = {
  organizationId: string;
  q?: string;
  status?: string;
  page: number;
  pageSize: number;
  dateFrom?: string;
  dateTo?: string;
};

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
   *
   * TEMP: Se usa `any` para unificar tipos Mongoose findOne vs create.
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

    // 1) organizationUser
    const userObjectId =
      typeof paymentRequest.userId === 'string'
        ? new Types.ObjectId(paymentRequest.userId)
        : paymentRequest.userId;

    const organizationUser = await this.organizationUserModel.findOne({
      user_id: userObjectId,
    });
    if (!organizationUser) throw new Error('OrganizationUser no encontrado');

    let paymentPlan = (await this.paymentPlanModel.findOne({
      organization_user_id: organizationUser._id,
    })) as any;

    // Si ya aplicaste este mismo pago (misma tx), sal temprano
    if (
      paymentPlan?.transactionId &&
      paymentRequest.transactionId &&
      paymentPlan.transactionId === paymentRequest.transactionId
    ) {
      return paymentPlan; // no enviar correos otra vez
    }

    if (paymentPlan) {
      // Solo enviar correo “updated” si realmente extendemos la fecha
      const shouldExtend =
        !paymentPlan.date_until || new Date(paymentPlan.date_until) < dateUntil;
      paymentPlan.price = amount;
      if (shouldExtend) {
        paymentPlan.date_until = dateUntil;
        await paymentPlan.save();
        await this.paymentPlansService.updateDateUntil(
          paymentPlan._id.toString(),
          dateUntil,
          organizationUser.properties?.nombres || 'Usuario',
        );
      } else {
        await paymentPlan.save(); // actualiza precio, sin correo
      }
    } else {
      paymentPlan = (await this.paymentPlansService.createPaymentPlan(
        organizationUser._id.toString(),
        MEMBERSHIP_DAYS,
        dateUntil,
        amount,
        organizationUser.properties?.nombres || 'Usuario',
        {
          source: 'gateway',
          status_history: paymentRequest.status_history ?? [],
          reference: paymentRequest.reference,
          transactionId: paymentRequest.transactionId,
          currency: paymentRequest.currency ?? 'COP',
          rawWebhook: paymentRequest.rawWebhook ?? undefined,
          payment_request_id: paymentRequest._id,
        },
      )) as any;
    }

    if (
      !organizationUser.payment_plan_id ||
      String(organizationUser.payment_plan_id) !== String(paymentPlan._id)
    ) {
      organizationUser.payment_plan_id = paymentPlan._id as any;
      await organizationUser.save();
    }
  }

  // src/payment-requests/payment-requests.service.ts
  async safeUpdateStatus({
    reference,
    nextStatus,
    transactionId,
    source,
    rawWompi,
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
    source: 'webhook' | 'poll' | 'redirect' | 'reconcile';
    rawWompi?: any;
  }): Promise<{
    doc: PaymentRequest | null;
    changed: boolean;
    becameApproved: boolean;
  }> {
    const current = await this.paymentRequestModel.findOne({ reference });
    if (!current) return { doc: null, changed: false, becameApproved: false };

    const prev = current.status;
    const next = nextStatus;

    // SIEMPRE: si llega raw, persistimos snapshot (aunque no cambie el estado)
    if (rawWompi) {
      current.wompi_snapshots = current.wompi_snapshots || [];
      current.wompi_snapshots.push({
        source,
        at: new Date(),
        payload: rawWompi,
      });
      // (opcional) limitar tamaño del historial:
      // if (current.wompi_snapshots.length > 20) {
      //   current.wompi_snapshots = current.wompi_snapshots.slice(-20);
      // }
    }

    // Idempotencia dura: si estado y txId no cambian, no toques nada
    const sameStatus = prev === next;
    const sameTx =
      !transactionId ||
      (current.transactionId && current.transactionId === transactionId);

    if (sameStatus && sameTx) {
      return { doc: current, changed: false, becameApproved: false };
    }

    current.status_history = current.status_history || [];
    current.status_history.push({
      at: new Date(),
      from: prev,
      to: next,
      source,
    });

    current.status = next;
    if (transactionId) current.transactionId = transactionId;
    if (source === 'webhook' && rawWompi) {
      current.rawWebhook = rawWompi;
    }

    await current.save();

    const becameApproved = prev !== 'APPROVED' && next === 'APPROVED';
    return { doc: current, changed: true, becameApproved };
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

  async search(params: SearchParams) {
    const { organizationId, q, status, page, pageSize, dateFrom, dateTo } =
      params;

    const match: any = { organizationId };
    if (status && status !== 'ALL') match.status = status;

    if (dateFrom || dateTo) {
      match.createdAt = {};
      if (dateFrom) match.createdAt.$gte = new Date(dateFrom);
      if (dateTo) match.createdAt.$lte = new Date(dateTo);
    }

    if (q) {
      match.$or = [
        { reference: { $regex: q, $options: 'i' } },
        { transactionId: { $regex: q, $options: 'i' } },
      ];
    }

    const pipeline: any[] = [
      { $match: match },
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          items: [
            { $skip: (page - 1) * pageSize },
            { $limit: pageSize },

            // userId (string) -> ObjectId (seguro)
            {
              $addFields: {
                userObjectId: {
                  $convert: {
                    input: '$userId',
                    to: 'objectId',
                    onError: null,
                    onNull: null,
                  },
                },
              },
            },

            // Join OrganizationUser por user_id
            {
              $lookup: {
                from: this.organizationUserModel.collection.name,
                let: { uId: '$userObjectId' },
                pipeline: [
                  { $match: { $expr: { $eq: ['$user_id', '$$uId'] } } },
                  { $limit: 1 },
                ],
                as: 'organizationUser',
              },
            },
            {
              $unwind: {
                path: '$organizationUser',
                preserveNullAndEmptyArrays: true,
              },
            },

            // Join PaymentPlan por organization_user_id; prioriza el que apunte a este PR
            {
              $lookup: {
                from: this.paymentPlanModel.collection.name,
                let: { ouId: '$organizationUser._id', prId: '$_id' },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ['$organization_user_id', '$$ouId'] },
                    },
                  },
                  {
                    $addFields: {
                      _score: {
                        $cond: [
                          { $eq: ['$payment_request_id', '$$prId'] },
                          2,
                          1,
                        ],
                      },
                    },
                  },
                  { $sort: { _score: -1, updated_at: -1, created_at: -1 } },
                  { $limit: 1 },
                ],
                as: 'paymentPlan',
              },
            },
            {
              $unwind: {
                path: '$paymentPlan',
                preserveNullAndEmptyArrays: true,
              },
            },

            {
              $project: {
                _id: 0,
                reference: 1,
                transactionId: 1,
                status: 1,
                amount: 1,
                currency: 1,
                createdAt: 1,
                updatedAt: 1,
                wompi_snapshots: 1,
                rawWebhook: 1,
                organizationUser: {
                  _id: '$organizationUser._id',
                  properties: '$organizationUser.properties',
                  user_id: '$organizationUser.user_id',
                },
                paymentPlan: {
                  _id: '$paymentPlan._id',
                  date_until: '$paymentPlan.date_until',
                  payment_request_id: '$paymentPlan.payment_request_id',
                },
              },
            },
          ],
          meta: [{ $count: 'total' }],
        },
      },
      {
        $project: {
          items: 1,
          total: { $ifNull: [{ $arrayElemAt: ['$meta.total', 0] }, 0] },
        },
      },
    ];
    const [res] = await this.paymentRequestModel
      .aggregate(pipeline)
      .allowDiskUse(true);
    return { items: res?.items ?? [], total: res?.total ?? 0 };
  }
}
