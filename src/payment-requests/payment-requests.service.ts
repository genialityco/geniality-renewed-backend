/* eslint-disable prefer-const */
import { Injectable, Logger } from '@nestjs/common';
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
import { PaymentLogsService } from 'src/payment-logs/payment-logs.service';

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

    private readonly paymentLogs: PaymentLogsService,
  ) {}

  async create(data: Partial<PaymentRequest>): Promise<PaymentRequest> {
    const pr = await this.paymentRequestModel.create(data);
    await this.paymentLogs.write({
      level: 'info',
      message: 'PaymentRequest creado service',
      source: 'service',
      reference: pr.reference,
      transactionId: pr.transactionId,
      organizationId: pr.organizationId,
      userId: String(pr.userId),
      amount: pr.amount,
      currency: pr.currency ?? 'COP',
      status: pr.status,
    });
    return pr;
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

    const doc = await this.paymentRequestModel.findOneAndUpdate(
      { reference },
      { $set },
      { new: true },
    );

    // Log: link de txId / update de status directo
    await this.paymentLogs.write({
      level: 'info',
      message: 'updateStatusAndTransactionId',
      source: 'service',
      reference,
      transactionId,
      status: status?.toUpperCase?.(),
      amount: doc?.amount,
      currency: doc?.currency ?? 'COP',
    });

    return doc;
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
    const dateUntilTarget = new Date(
      now.getTime() + MEMBERSHIP_DAYS * 24 * 60 * 60 * 1000,
    );

    if (!paymentRequest?.userId) {
      // Log error y lanza
      await this.paymentLogs.write({
        level: 'error',
        message: 'activateMembershipForPayment: PaymentRequest sin userId',
        source: 'service',
        reference: paymentRequest?.reference,
        transactionId: paymentRequest?.transactionId,
        organizationId: paymentRequest?.organizationId,
        amount,
        currency: paymentRequest?.currency ?? 'COP',
      });
      throw new Error('PaymentRequest sin userId');
    }

    // 1) organizationUser (filtrando por organización también)
    const userObjectId =
      typeof paymentRequest.userId === 'string'
        ? new Types.ObjectId(paymentRequest.userId)
        : paymentRequest.userId;

    const organizationUser = await this.organizationUserModel.findOne({
      user_id: userObjectId,
      organization_id: paymentRequest.organizationId,
    });

    if (!organizationUser) {
      await this.paymentLogs.write({
        level: 'error',
        message: 'activateMembershipForPayment: OrganizationUser no encontrado',
        source: 'service',
        reference: paymentRequest.reference,
        transactionId: paymentRequest.transactionId,
        organizationId: paymentRequest.organizationId,
        userId: String(paymentRequest.userId),
        amount,
        currency: paymentRequest.currency ?? 'COP',
      });
      throw new Error('OrganizationUser no encontrado');
    }

    // 2) Busca plan actual
    let paymentPlan = await this.paymentPlanModel
      .findOne({ organization_user_id: organizationUser._id })
      .exec();

    // 2.1) Idempotencia por Tx
    if (
      paymentPlan?.transactionId &&
      paymentRequest.transactionId &&
      paymentPlan.transactionId === paymentRequest.transactionId
    ) {
      await this.paymentLogs.write({
        level: 'info',
        message:
          'activateMembershipForPayment: idempotente (misma transactionId)',
        source: 'service',
        reference: paymentRequest.reference,
        transactionId: paymentRequest.transactionId,
        organizationId: paymentRequest.organizationId,
        userId: String(paymentRequest.userId),
        amount,
        currency: paymentRequest.currency ?? 'COP',
        meta: { paymentPlanId: String(paymentPlan._id) },
      });
      return paymentPlan;
    }

    try {
      // 3) Crear si no existe
      if (!paymentPlan) {
        paymentPlan = (await this.paymentPlansService.createPaymentPlan(
          organizationUser._id.toString(),
          MEMBERSHIP_DAYS,
          dateUntilTarget,
          amount,
          organizationUser.properties?.nombres || 'Usuario',
          {
            source: 'gateway',
            reference: paymentRequest.reference,
            transactionId: paymentRequest.transactionId,
            currency: paymentRequest.currency,
            rawWebhook: paymentRequest.rawWebhook,
            payment_request_id: paymentRequest._id,
          },
        )) as any;

        await this.paymentLogs.write({
          level: 'info',
          message: 'PaymentPlan creado (gateway)',
          source: 'service',
          reference: paymentRequest.reference,
          transactionId: paymentRequest.transactionId,
          organizationId: paymentRequest.organizationId,
          userId: String(paymentRequest.userId),
          amount,
          currency: paymentRequest.currency ?? 'COP',
          meta: {
            paymentPlanId: String(paymentPlan._id),
            action: 'create',
            dateUntil: paymentPlan.date_until,
          },
        });
      } else {
        // 4) Actualizar / Extender
        const currentUntil = paymentPlan.date_until
          ? new Date(paymentPlan.date_until)
          : null;
        const shouldExtend = !currentUntil || currentUntil < dateUntilTarget;

        if (shouldExtend) {
          paymentPlan = (await this.paymentPlansService.updateDateUntil(
            paymentPlan._id.toString(),
            dateUntilTarget,
            organizationUser.properties?.nombres || 'Usuario',
            'gateway',
            {
              price: amount,
              payment_request_id: paymentRequest._id,
              transactionId: paymentRequest.transactionId,
              reference: paymentRequest.reference,
              currency: paymentRequest.currency,
              rawWebhook: paymentRequest.rawWebhook,
            },
          )) as any;

          await this.paymentLogs.write({
            level: 'info',
            message: 'PaymentPlan extendido (gateway)',
            source: 'service',
            reference: paymentRequest.reference,
            transactionId: paymentRequest.transactionId,
            organizationId: paymentRequest.organizationId,
            userId: String(paymentRequest.userId),
            amount,
            currency: paymentRequest.currency ?? 'COP',
            meta: {
              paymentPlanId: String(paymentPlan._id),
              action: 'extend',
              dateUntil: paymentPlan.date_until,
            },
          });
        } else {
          // Solo metadata
          paymentPlan.price = amount;
          paymentPlan.payment_request_id = paymentRequest._id;
          paymentPlan.transactionId = paymentRequest.transactionId;
          paymentPlan.reference = paymentRequest.reference;
          paymentPlan.currency = paymentRequest.currency;
          paymentPlan.rawWebhook = paymentRequest.rawWebhook;
          await paymentPlan.save();

          await this.paymentLogs.write({
            level: 'info',
            message: 'PaymentPlan metadata actualizada (gateway)',
            source: 'service',
            reference: paymentRequest.reference,
            transactionId: paymentRequest.transactionId,
            organizationId: paymentRequest.organizationId,
            userId: String(paymentRequest.userId),
            amount,
            currency: paymentRequest.currency ?? 'COP',
            meta: {
              paymentPlanId: String(paymentPlan._id),
              action: 'metadata',
              dateUntil: paymentPlan.date_until,
            },
          });
        }
      }

      // 5) Enlazar plan al OrganizationUser
      if (
        !organizationUser.payment_plan_id ||
        String(organizationUser.payment_plan_id) !== String(paymentPlan._id)
      ) {
        organizationUser.payment_plan_id = paymentPlan._id as any;
        await organizationUser.save();

        await this.paymentLogs.write({
          level: 'info',
          message: 'OrganizationUser.link payment_plan_id',
          source: 'service',
          reference: paymentRequest.reference,
          transactionId: paymentRequest.transactionId,
          organizationId: paymentRequest.organizationId,
          userId: String(paymentRequest.userId),
          meta: { paymentPlanId: String(paymentPlan._id) },
        });
      }

      return paymentPlan;
    } catch (e: any) {
      await this.paymentLogs.write({
        level: 'error',
        message: 'activateMembershipForPayment: fallo',
        source: 'service',
        reference: paymentRequest.reference,
        transactionId: paymentRequest.transactionId,
        organizationId: paymentRequest.organizationId,
        userId: String(paymentRequest.userId),
        amount,
        currency: paymentRequest.currency ?? 'COP',
        meta: { error: e?.message || String(e) },
      });
      throw e;
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
    source: 'frontend' | 'webhook' | 'poll' | 'reconcile' | 'service';
    rawWompi?: any;
  }): Promise<{
    doc: PaymentRequest | null;
    changed: boolean;
    becameApproved: boolean;
  }> {
    const current = await this.paymentRequestModel.findOne({ reference });
    if (!current) {
      await this.paymentLogs.write({
        level: 'warn',
        message: 'safeUpdateStatus: PR no encontrado',
        source,
        reference,
        transactionId,
        status: String(nextStatus).toUpperCase(),
      });
      return { doc: null, changed: false, becameApproved: false };
    }

    const allowed = [
      'CREATED',
      'PENDING',
      'APPROVED',
      'DECLINED',
      'VOIDED',
      'ERROR',
    ] as const;
    type Allowed = (typeof allowed)[number];

    const prev = (current.status || 'CREATED').toUpperCase() as Allowed;
    const next = (String(nextStatus || '') as string).toUpperCase() as Allowed;

    // Rechazar silenciosamente estados no permitidos
    if (!allowed.includes(next)) {
      await this.paymentLogs.write({
        level: 'warn',
        message: 'safeUpdateStatus: estado no permitido',
        source,
        reference,
        transactionId,
        status: next,
        meta: { prev },
      });
      return { doc: current, changed: false, becameApproved: false };
    }

    // Siempre: si llega raw, persistimos snapshot (aunque no cambie el estado)
    if (rawWompi) {
      current.wompi_snapshots = current.wompi_snapshots || [];
      current.wompi_snapshots.push({
        source,
        at: new Date(),
        payload: rawWompi,
      });
      // opcional: limitar historial a últimos 20
      if (current.wompi_snapshots.length > 20) {
        current.wompi_snapshots = current.wompi_snapshots.slice(-20);
      }
    }

    // Idempotencia dura: estado y tx sin cambios
    const sameStatus = prev === next;
    const sameTx =
      !transactionId ||
      (current.transactionId && current.transactionId === transactionId);
    if (sameStatus && sameTx) {
      await this.paymentLogs.write({
        level: 'info',
        message: 'safeUpdateStatus: sin cambios (idempotente)',
        source,
        reference,
        transactionId: current.transactionId,
        status: current.status,
      });
      return { doc: current, changed: false, becameApproved: false };
    }

    // Reglas de transición:
    // - Estados terminales (APPROVED/DECLINED/VOIDED/ERROR) no retroceden.
    // - Prioridad simple para evitar "retrocesos" (CREATED < PENDING < TERMINAL)
    const terminal = new Set<Allowed>([
      'APPROVED',
      'DECLINED',
      'VOIDED',
      'ERROR',
    ]);
    const rank: Record<Allowed, number> = {
      CREATED: 1,
      PENDING: 2,
      APPROVED: 3,
      DECLINED: 3,
      VOIDED: 3,
      ERROR: 3,
    };

    // Si ya estamos en terminal y next es distinto, ignorar cambio
    if (terminal.has(prev) && prev !== next) {
      await this.paymentLogs.write({
        level: 'warn',
        message: 'safeUpdateStatus: intento de retroceso desde terminal',
        source,
        reference,
        transactionId,
        status: next,
        meta: { prev },
      });
      return { doc: current, changed: false, becameApproved: false };
    }

    // Si la prioridad del next es menor que la del prev, ignorar (evita retrocesos)
    if (rank[next] < rank[prev]) {
      await this.paymentLogs.write({
        level: 'warn',
        message: 'safeUpdateStatus: retroceso bloqueado',
        source,
        reference,
        transactionId,
        status: next,
        meta: { prev },
      });
      return { doc: current, changed: false, becameApproved: false };
    }

    // Historial solo si hay cambio efectivo de estado
    if (prev !== next) {
      current.status_history = current.status_history || [];
      current.status_history.push({
        at: new Date(),
        from: prev,
        to: next,
        source,
      });
      current.status = next;
    }

    // Manejo de transactionId:
    // - Si no hay current.transactionId, setear el nuevo.
    // - Si ya existe y es diferente, no sobreescribir (evita pisar otro intento).

    if (transactionId) {
      if (!current.transactionId) {
        current.transactionId = transactionId;
      } else if (current.transactionId !== transactionId) {
        Logger.warn(
          `Intento de sobrescribir transactionId para ${reference}: ${current.transactionId} -> ${transactionId}`,
        );
        await this.paymentLogs.write({
          level: 'warn',
          message: 'safeUpdateStatus: intento de sobrescribir transactionId',
          source,
          reference,
          transactionId,
          status: next,
          meta: { prevTx: current.transactionId },
        });
      }
    }

    // Si viene de webhook y hay raw, también guarda rawWebhook "principal"
    if (source === 'webhook' && rawWompi) {
      current.rawWebhook = rawWompi;
    }

    // becameApproved antes de persistir (usa prev y next ya normalizados)
    const becameApproved = prev !== 'APPROVED' && next === 'APPROVED';

    // Guardar con tolerancia a E11000 (collision en transactionId)
    try {
      await current.save();
      await this.paymentLogs.write({
        level: 'info',
        message: 'Estado PR actualizado',
        source,
        reference,
        transactionId: current.transactionId,
        status: current.status,
        amount: current.amount,
        currency: current.currency ?? 'COP',
        meta: { from: prev, to: next, becameApproved },
      });
    } catch (e: any) {
      // Si falla por índice único en transactionId, reintentar sin setearlo
      if (e?.code === 11000 && e?.message?.includes?.('transactionId')) {
        // revertir el cambio de transactionId y guardar de nuevo
        if (transactionId && current.transactionId === transactionId) {
          current.transactionId = undefined;
        }
        await current.save();
        await this.paymentLogs.write({
          level: 'warn',
          message: 'safeUpdateStatus: E11000 transactionId, guardado sin txId',
          source,
          reference,
          status: current.status,
          meta: { from: prev, to: next, error: e?.message },
        });
      } else {
        await this.paymentLogs.write({
          level: 'error',
          message: 'safeUpdateStatus: fallo al guardar',
          source,
          reference,
          transactionId,
          status: next,
          meta: { error: e?.message || String(e) },
        });
        throw e;
      }
    }

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

    // Filtros "baratos" que sí existen en la colección base (sin joins)
    const baseMatch: any = { organizationId };
    if (status && status !== 'ALL') baseMatch.status = status;

    if (dateFrom || dateTo) {
      baseMatch.createdAt = {};
      if (dateFrom) baseMatch.createdAt.$gte = new Date(dateFrom);
      if (dateTo) baseMatch.createdAt.$lte = new Date(dateTo);
    }

    // Construimos el pipeline:
    // 1) Filtrar por base, 2) ordenar, 3) lookups, 4) filtrar por 'q' (incluye campos del join), 5) facet
    const pipeline: any[] = [
      { $match: baseMatch },
      { $sort: { createdAt: -1 } },

      // userId (string) -> ObjectId (seguro) para poder hacer join por user_id
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
            { $match: { $expr: { $eq: ['$organization_user_id', '$$ouId'] } } },
            {
              $addFields: {
                _score: {
                  $cond: [{ $eq: ['$payment_request_id', '$$prId'] }, 2, 1],
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
        $addFields: {
          _snapCount: { $size: { $ifNull: ['$wompi_snapshots', []] } },
        },
      },
      {
        $addFields: {
          _lastSnap: {
            $cond: [
              { $gt: ['$_snapCount', 0] },
              {
                $arrayElemAt: [
                  '$wompi_snapshots',
                  { $subtract: ['$_snapCount', 1] },
                ],
              },
              null,
            ],
          },
        },
      },
      // Extraer candidate transaction desde el último snapshot (cubre formatos comunes)
      {
        $addFields: {
          _txPayload: '$_lastSnap.payload',
          _txData: { $ifNull: ['$_lastSnap.payload.data', null] },
          _txDataTx: {
            $ifNull: ['$_lastSnap.payload.data.transaction', null],
          },
          _txRootTx: { $ifNull: ['$_lastSnap.payload.transaction', null] },
        },
      },
      // customer_email preferente desde snapshot y desde rawWebhook
      {
        $addFields: {
          _customerEmailFromSnap: {
            $ifNull: [
              { $ifNull: ['$_txData.customer_email', null] },
              {
                $ifNull: [
                  '$_txDataTx.customer_email',
                  {
                    $ifNull: [
                      '$_txRootTx.customer_email',
                      { $ifNull: ['$_txPayload.customer_email', null] },
                    ],
                  },
                ],
              },
            ],
          },
          _customerEmailFromRaw: {
            $ifNull: [
              '$rawWebhook.data.transaction.customer_email', // algunos payloads
              '$rawWebhook.transaction.customer_email', // tu ejemplo concreto
            ],
          },
        },
      },
    ];
    if (q && q.trim()) {
      const regex = new RegExp(q.trim(), 'i');
      pipeline.push({
        $match: {
          $or: [
            { reference: { $regex: regex } },
            { transactionId: { $regex: regex } },
            { 'organizationUser.properties.email': { $regex: regex } },
            { 'organizationUser.properties.names': { $regex: regex } },
            { 'organizationUser.properties.nombres': { $regex: regex } },
            { 'organizationUser.properties.apellidos': { $regex: regex } },
            { _customerEmailFromSnap: { $regex: regex } },
            { _customerEmailFromRaw: { $regex: regex } },
          ],
        },
      });
    }

    // Facet para paginar y contar DESPUÉS de todos los filtros
    pipeline.push(
      {
        $facet: {
          items: [
            { $skip: (page - 1) * pageSize },
            { $limit: pageSize },
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
    );

    const [res] = await this.paymentRequestModel
      .aggregate(pipeline)
      .allowDiskUse(true);
    return { items: res?.items ?? [], total: res?.total ?? 0 };
  }
}
