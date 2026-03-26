// payment-plans.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PaymentPlan } from './schemas/payment-plan.schema';
import { OrganizationUser } from '../organization-users/schemas/organization-user.schema'; // Ajusta la ruta según tu estructura
import { EmailService } from '../email/email.service'; // Ajusta la ruta
import { renderSubscriptionContent } from '../templates/PaySuscription';
import { PaymentRequest } from '../payment-requests/schemas/payment-request.schema';

// ── Tipos para el reporte de reconciliación Wompi ─────────────────────────

export interface WompiTransactionRow {
  transactionId: string;
  reference: string | null;
  status: string;
  amount: number;
  currency: string;
  customerEmail: string | null;
  paymentMethodType: string | null;
  wompiCreatedAt: string | null;
  paymentRequest: { _id: string; reference: string; status: string } | null;
  organizationUser: {
    _id: string;
    email: string | null;
    identification: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null;
  paymentPlan: {
    _id: string;
    status: 'active' | 'expired';
    date_until: Date;
    price: number;
    source: string;
  } | null;
  /** Cómo se encontró la coincidencia en BD */
  matchedBy: 'reference' | 'transaction_id_on_pr' | 'transaction_id_on_plan' | 'email' | null;
  /** fully_linked = tiene plan | has_user_no_plan = usuario existe pero sin plan | no_db_match = no encontrado */
  dbStatus: 'fully_linked' | 'has_user_no_plan' | 'no_db_match';
}

export interface PlanWithoutWompiRow {
  paymentPlanId: string;
  organizationUserId: string;
  email: string | null;
  identification: string | null;
  firstName: string | null;
  lastName: string | null;
  source: string;
  status: 'active' | 'expired';
  date_until: Date;
  price: number;
  transactionId: string | null;
  payment_request_id: string | null;
  created_at: Date;
}

export interface WompiReconcileResult {
  summary: {
    /** Transacciones Wompi que pasaron el filtro de monto */
    wompiTotal: number;
    /** Transacciones Wompi donde se encontró un plan en BD (puede superar matchedPlans si hay pagos múltiples) */
    fullyLinked: number;
    /** Transacciones Wompi donde el usuario existe pero no tiene plan */
    hasUserNoPlan: number;
    /** Transacciones Wompi sin ninguna coincidencia en BD */
    noDbMatch: number;
    /** Planes únicos en BD que tienen al menos una transacción Wompi vinculada */
    matchedPlans: number;
    /** Planes en BD sin ninguna transacción Wompi vinculada */
    plansWithoutWompi: number;
    /** Total de planes en BD para esta org — debe ser igual a matchedPlans + plansWithoutWompi */
    totalPlans: number;
    generatedAt: Date;
  };
  wompiTransactions: WompiTransactionRow[];
  plansWithoutWompi: PlanWithoutWompiRow[];
}

// ── Tipos para clasificación completa ────────────────────────────────────

export type SubscriptionClassification =
  | 'pagado_sin_renovar'
  | 'pagado_renovado_pagando'
  | 'pagado_renovado_cortesia'
  | 'cortesia_sin_renovar'
  | 'cortesia_renovada_pagando'
  | 'cortesia_renovada_cortesia'
  | 'sin_plan';

export interface ClassificationWompiPayment {
  transactionId: string | null;
  reference: string | null;
  amount: number;
  paymentDate: Date | null;
  /** true si el pago cae dentro del período original del plan */
  isOriginalPeriod: boolean;
}

export interface ClassificationItem {
  organizationUserId: string;
  email: string | null;
  identification: string | null;
  firstName: string | null;
  lastName: string | null;
  paymentPlan: {
    _id: string;
    status: 'active' | 'expired';
    date_until: Date;
    price: number;
    source: string;
    created_at: Date;
    days: number;
    isRenewed: boolean;
  } | null;
  wompiPayments: ClassificationWompiPayment[];
  classification: SubscriptionClassification;
}

export interface FullClassificationSummary extends Record<SubscriptionClassification, number> {
  total: number;
  generatedAt: Date;

  // ── Totales por estado de plan ──────────────────────────────────────────
  totalWithPlan: number;          // total - sin_plan
  totalActive: number;            // planes activos (cualquier clasificación)
  totalExpired: number;           // planes vencidos

  // ── Renovación sobre TODOS los que tienen plan (activos + vencidos) ─────
  totalRenewed: number;
  totalNotRenewed: number;
  // Cruce renovación × estado de plan
  renewedActive: number;
  renewedExpired: number;
  notRenewedActive: number;
  notRenewedExpired: number;
  // Cruce renovación × fuente de pago (Wompi como fuente de verdad)
  totalRenewed_conWompi: number;
  totalRenewed_sinWompi: number;
  totalNotRenewed_conWompi: number;
  totalNotRenewed_sinWompi: number;
  // Triple cruce: renovación × fuente × estado
  renewedActive_conWompi: number;
  renewedActive_sinWompi: number;
  renewedExpired_conWompi: number;
  renewedExpired_sinWompi: number;
  notRenewedActive_conWompi: number;
  notRenewedActive_sinWompi: number;
  notRenewedExpired_conWompi: number;
  notRenewedExpired_sinWompi: number;

  // ── Fuente de pago — histórico total (activos + vencidos) ────────────────
  // Basado en wompiPayments.length > 0 (fuente de verdad: Wompi)
  // Este total es comparable con el "matchedPlans" de reconciliación Wompi
  totalConWompi: number;          // usuarios con ≥1 pago Wompi (cualquier estado)
  totalSinWompi: number;          // usuarios con plan pero sin ningún pago Wompi

  // ── De los activos: fuente de pago (Wompi como fuente de verdad) ────────
  // activePagaron = activos con wompiPayments.length > 0
  // Incluye cortesia_renovada_pagando (pagaron renovación aunque original fue gratis)
  activePagaron: number;
  activeCortesia: number;         // activos sin ningún pago Wompi

  // ── De los activos que tienen pago Wompi — desglose por clasificación ───
  activePagaron_sinRenovar: number;           // pagado_sin_renovar activo
  activePagaron_renovaronPagando: number;     // pagado_renovado_pagando activo
  activePagaron_renovaronCortesia: number;    // pagado_renovado_cortesia activo
  activePagaron_cortesiaRenovoPagando: number; // cortesia_renovada_pagando activo (original gratis, renovó pagando)

  // ── De los activos sin pago Wompi ────────────────────────────────────────
  activeCortesia_sinRenovar: number;
  activeCortesia_renovaronCortesia: number;

  // ── De los vencidos: cuántos habían pagado Wompi ─────────────────────────
  expiredConWompi: number;
  expiredSinWompi: number;
}

export interface UnmatchedWompiTransaction {
  transactionId: string | null;
  customerEmail: string | null;
  reference: string | null;
  amount: number;
  createdAt: string | null;
}

export interface FullClassificationResult {
  summary: FullClassificationSummary;
  items: ClassificationItem[];
  unmatchedWompiTransactions: UnmatchedWompiTransaction[];
}

type PlanMeta = {
  source?: 'gateway' | 'manual' | 'admin' |'cron_approved';
  status_history?: any[];
  reference?: string;
  transactionId?: string;
  currency?: string;
  rawWebhook?: any;
  payment_request_id?: any;
};

@Injectable()
export class PaymentPlansService {
  constructor(
    @InjectModel(PaymentPlan.name)
    private paymentPlanModel: Model<PaymentPlan>,
    @InjectModel(OrganizationUser.name)
    private organizationUserModel: Model<OrganizationUser>,
    @InjectModel(PaymentRequest.name)
    private paymentRequestModel: Model<PaymentRequest>,
    private readonly emailService: EmailService,
  ) {}

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
    meta?: PlanMeta,
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
      payment_request_id: meta?.payment_request_id,
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
    source?: string,
    additionalFields?: {
      price?: number;
      payment_request_id?: any;
      transactionId?: string;
      reference?: string;
      currency?: string;
      rawWebhook?: any;
    },
  ): Promise<PaymentPlan> {
    const updateData: any = { date_until };

    // Agregar 'source' si lo envían
    if (source) {
      updateData.source = source;
    }

    // Agregar campos adicionales si se proporcionan
    if (additionalFields) {
      Object.assign(updateData, additionalFields);
    }

    const plan = await this.paymentPlanModel.findByIdAndUpdate(
      paymentPlanId,
      updateData,
      { new: true },
    );
    if (!plan) {
      throw new NotFoundException('PaymentPlan no encontrado');
    }
    const email = await this.getEmailByOrganizationUserId(
      plan.organization_user_id as unknown as string,
    );
    if (email) {
      const html = renderSubscriptionContent({
        dateUntil: date_until,
        variant: 'updated',
        nameUser: nameUser,
      });
      const Subject = '¡Tu suscripción fue actualizada!';
      await this.emailService.sendLayoutEmail(
        email,
        Subject,
        html,
        plan.organization_user_id as unknown as string,
      );
    }
    return plan;
  }
  // Nuevo método para eliminar un PaymentPlan
  async deletePaymentPlan(paymentPlanId: string): Promise<void> {
    const deleted = await this.paymentPlanModel
      .findByIdAndDelete(paymentPlanId)
      .exec();
    if (!deleted) {
      throw new NotFoundException('PaymentPlan no encontrado');
    }
  }

  async getSubscriptionReport(organizationId: string): Promise<{
    totalPaid: number;
    totalActive: number;
    totalExpired: number;
    totalRenewals: number;
    renewalsGateway: number;
    renewalsMigrated: number;
    activeNotRenewed: number;
    activeRenewed: number;
    totalUnpaid: number;
    bySource: { gateway: number; admin: number; manual: number };
    platformPayments: number;
    migratedPayments: number;
    generatedAt: Date;
  }> {
    const orgObjectId = new Types.ObjectId(organizationId);
    const now = new Date();
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    const [planStats] = await this.paymentPlanModel.aggregate([
      {
        $lookup: {
          from: this.organizationUserModel.collection.name,
          localField: 'organization_user_id',
          foreignField: '_id',
          as: 'orgUser',
        },
      },
      { $unwind: '$orgUser' },
      { $match: { 'orgUser.organization_id': orgObjectId } },
      {
        $facet: {
          paid: [{ $count: 'n' }],
          active: [
            {
              $match: {
                $expr: { $gte: [{ $toDate: '$date_until' }, now] },
              },
            },
            { $count: 'n' },
          ],
          expired: [
            {
              $match: {
                $expr: { $lt: [{ $toDate: '$date_until' }, now] },
              },
            },
            { $count: 'n' },
          ],
          renewals: [
            {
              $match: {
                $expr: {
                  $gt: [
                    { $toDate: '$date_until' },
                    {
                      $add: [
                        { $toDate: '$created_at' },
                        { $multiply: [{ $toLong: '$days' }, MS_PER_DAY] },
                        MS_PER_DAY,
                      ],
                    },
                  ],
                },
              },
            },
            { $count: 'n' },
          ],
          // Activos sin renovar (vigentes, primer año)
          activeNotRenewed: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $gte: [{ $toDate: '$date_until' }, now] },
                    {
                      $lte: [
                        { $toDate: '$date_until' },
                        {
                          $add: [
                            { $toDate: '$created_at' },
                            { $multiply: [{ $toLong: '$days' }, MS_PER_DAY] },
                            MS_PER_DAY,
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
            { $count: 'n' },
          ],
          // Activos renovados (vigentes y extendidos)
          activeRenewed: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $gte: [{ $toDate: '$date_until' }, now] },
                    {
                      $gt: [
                        { $toDate: '$date_until' },
                        {
                          $add: [
                            { $toDate: '$created_at' },
                            { $multiply: [{ $toLong: '$days' }, MS_PER_DAY] },
                            MS_PER_DAY,
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
            { $count: 'n' },
          ],
          // Por origen del pago
          sourceGateway: [
            { $match: { source: 'gateway' } },
            { $count: 'n' },
          ],
          sourceAdmin: [
            { $match: { source: 'admin' } },
            { $count: 'n' },
          ],
          sourceManual: [
            { $match: { source: 'manual' } },
            { $count: 'n' },
          ],
          // Pagos de la plataforma actual (tienen payment_request_id)
          withPaymentRequest: [
            {
              $match: {
                payment_request_id: { $exists: true, $ne: null },
              },
            },
            { $count: 'n' },
          ],
          // Pagos migrados (no tienen payment_request_id)
          withoutPaymentRequest: [
            {
              $match: {
                $or: [
                  { payment_request_id: { $exists: false } },
                  { payment_request_id: null },
                ],
              },
            },
            { $count: 'n' },
          ],
        },
      },
    ]);

    const totalPaid = planStats?.paid[0]?.n ?? 0;
    const totalActive = planStats?.active[0]?.n ?? 0;
    const totalExpired = planStats?.expired[0]?.n ?? 0;
    const totalRenewals = planStats?.renewals[0]?.n ?? 0;
    const activeNotRenewed = planStats?.activeNotRenewed[0]?.n ?? 0;
    const activeRenewed = planStats?.activeRenewed[0]?.n ?? 0;

    // Para separar renovaciones, cruzamos planes extendidos con sus PaymentRequests APPROVED.
    // - renewalsGateway: plan extendido Y tiene al menos 1 PR APPROVED (pagó en esta plataforma)
    // - renewalsMigrated: plan extendido Y no tiene ningún PR APPROVED (extensión sin pago)
    const [renewalStats] = await this.paymentPlanModel.aggregate([
      {
        $lookup: {
          from: this.organizationUserModel.collection.name,
          localField: 'organization_user_id',
          foreignField: '_id',
          as: 'orgUser',
        },
      },
      { $unwind: '$orgUser' },
      { $match: { 'orgUser.organization_id': orgObjectId } },
      // Solo planes extendidos
      {
        $match: {
          $expr: {
            $gt: [
              { $toDate: '$date_until' },
              {
                $add: [
                  { $toDate: '$created_at' },
                  { $multiply: [{ $toLong: '$days' }, MS_PER_DAY] },
                  MS_PER_DAY,
                ],
              },
            ],
          },
        },
      },
      // Contar PaymentRequests APPROVED del usuario en esta org
      {
        $lookup: {
          from: this.paymentRequestModel.collection.name,
          let: {
            userId: { $toString: '$orgUser.user_id' },
            orgId: organizationId,
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$userId', '$$userId'] },
                    { $eq: ['$organizationId', '$$orgId'] },
                    { $eq: ['$status', 'APPROVED'] },
                  ],
                },
              },
            },
            { $count: 'n' },
          ],
          as: 'approvedRequests',
        },
      },
      {
        $addFields: {
          approvedCount: {
            $ifNull: [{ $arrayElemAt: ['$approvedRequests.n', 0] }, 0],
          },
        },
      },
      {
        $facet: {
          gateway: [
            { $match: { approvedCount: { $gte: 1 } } },
            { $count: 'n' },
          ],
          migrated: [
            { $match: { approvedCount: 0 } },
            { $count: 'n' },
          ],
        },
      },
    ]);

    const renewalsGateway = renewalStats?.gateway[0]?.n ?? 0;
    const renewalsMigrated = renewalStats?.migrated[0]?.n ?? 0;
    const bySource = {
      gateway: planStats?.sourceGateway[0]?.n ?? 0,
      admin: planStats?.sourceAdmin[0]?.n ?? 0,
      manual: planStats?.sourceManual[0]?.n ?? 0,
    };
    const platformPayments = planStats?.withPaymentRequest[0]?.n ?? 0;
    const migratedPayments = planStats?.withoutPaymentRequest[0]?.n ?? 0;

    const [totalOrgUsersStats] = await this.organizationUserModel.aggregate([
      { $match: { organization_id: orgObjectId } },
      { $count: 'n' },
    ]);
    const totalOrgUsers = totalOrgUsersStats?.n ?? 0;
    const totalUnpaid = Math.max(0, totalOrgUsers - totalPaid);

    return {
      totalPaid,
      totalActive,
      totalExpired,
      totalRenewals,
      renewalsGateway,
      renewalsMigrated,
      activeNotRenewed,
      activeRenewed,
      totalUnpaid,
      bySource,
      platformPayments,
      migratedPayments,
      generatedAt: now,
    };
  }

  /**
   * Recibe la lista de transacciones de Wompi ya obtenida desde la API
   * y las cruza con la BD de la organización.
   *
   * Matching por orden de confianza:
   *  1. reference          → PaymentRequest.reference → userId → OrganizationUser → PaymentPlan
   *  2. transactionId      → PaymentRequest.transactionId (mismo camino)
   *  3. transactionId      → PaymentPlan.transactionId directo (planes cron_approved)
   *  4. customer_email     → OrganizationUser.properties.email (fallback)
   *
   * También retorna todos los PaymentPlans de la org que NO tienen
   * ninguna transacción Wompi vinculada (planes migrados/manuales).
   */
  async reconcileWompiTransactions(
    wompiTransactions: any[],
    organizationId: string,
  ): Promise<WompiReconcileResult> {
    const orgObjectId = new Types.ObjectId(organizationId);
    const now = new Date();

    // ── Pre-carga de datos de BD para evitar N+1 queries ─────────────────────

    const allPRs = await this.paymentRequestModel
      .find({ organizationId })
      .lean();

    const prByReference = new Map<string, any>();
    const prByTransactionId = new Map<string, any>();
    for (const pr of allPRs) {
      if (pr.reference) prByReference.set(pr.reference, pr);
      if (pr.transactionId) prByTransactionId.set(pr.transactionId, pr);
    }

    const allOrgUsers = await this.organizationUserModel
      .find({ organization_id: orgObjectId })
      .lean();

    const orgUserByUserId = new Map<string, any>();
    const orgUserByEmail = new Map<string, any>();
    for (const ou of allOrgUsers) {
      orgUserByUserId.set(String(ou.user_id), ou);
      const email = (ou.properties?.email ?? '').toLowerCase().trim();
      if (email) orgUserByEmail.set(email, ou);
    }

    // PaymentPlans con el orgUser ya unido (para poder filtrar por org_id)
    const allPlans: any[] = await this.paymentPlanModel.aggregate([
      {
        $lookup: {
          from: this.organizationUserModel.collection.name,
          localField: 'organization_user_id',
          foreignField: '_id',
          as: 'orgUser',
        },
      },
      { $unwind: '$orgUser' },
      { $match: { 'orgUser.organization_id': orgObjectId } },
    ]);

    const planByOrgUserId = new Map<string, any>();
    const planByTransactionId = new Map<string, any>();
    const planByPaymentRequestId = new Map<string, any>();
    for (const plan of allPlans) {
      planByOrgUserId.set(String(plan.organization_user_id), plan);
      if (plan.transactionId) planByTransactionId.set(plan.transactionId, plan);
      if (plan.payment_request_id)
        planByPaymentRequestId.set(String(plan.payment_request_id), plan);
    }

    // ── Cruce de transacciones Wompi con BD ───────────────────────────────────

    const matchedPlanIds = new Set<string>();
    const wompiRows: WompiTransactionRow[] = [];

    for (const tx of wompiTransactions) {
      const txId: string = tx.id;
      const reference: string | null = tx.reference ?? null;
      const customerEmail = (tx.customer_email ?? '').toLowerCase().trim();

      let paymentRequest: any = null;
      let orgUser: any = null;
      let paymentPlan: any = null;
      let matchedBy: WompiTransactionRow['matchedBy'] = null;

      // Nivel 1: reference → PaymentRequest → userId → OrganizationUser → PaymentPlan
      if (reference && prByReference.has(reference)) {
        paymentRequest = prByReference.get(reference);
        matchedBy = 'reference';
      }

      // Nivel 2: transactionId → PaymentRequest (si no se encontró por reference)
      if (!paymentRequest && txId && prByTransactionId.has(txId)) {
        paymentRequest = prByTransactionId.get(txId);
        matchedBy = 'transaction_id_on_pr';
      }

      if (paymentRequest) {
        orgUser = orgUserByUserId.get(paymentRequest.userId);
        if (orgUser) {
          paymentPlan =
            planByOrgUserId.get(String(orgUser._id)) ??
            planByPaymentRequestId.get(String(paymentRequest._id)) ??
            null;
        }
      }

      // Nivel 3: transactionId directamente en PaymentPlan (cron_approved)
      if (!paymentPlan && txId && planByTransactionId.has(txId)) {
        paymentPlan = planByTransactionId.get(txId);
        matchedBy = matchedBy ?? 'transaction_id_on_plan';
        if (!orgUser)
          orgUser = orgUserByUserId.get(String(paymentPlan.orgUser?.user_id ?? ''));
      }

      // Nivel 4: customer_email → OrganizationUser.properties.email
      if (!orgUser && customerEmail && orgUserByEmail.has(customerEmail)) {
        orgUser = orgUserByEmail.get(customerEmail);
        matchedBy = matchedBy ?? 'email';
        if (!paymentPlan)
          paymentPlan = planByOrgUserId.get(String(orgUser._id)) ?? null;
      }

      if (paymentPlan) matchedPlanIds.add(String(paymentPlan._id));

      const ou = orgUser ?? paymentPlan?.orgUser ?? null;
      const identification =
        ou?.properties?.ID ??
        ou?.properties?.cedula ??
        ou?.properties?.identificacion ??
        ou?.properties?.documento ??
        null;

      const dbStatus: WompiTransactionRow['dbStatus'] = paymentPlan
        ? 'fully_linked'
        : orgUser
          ? 'has_user_no_plan'
          : 'no_db_match';

      wompiRows.push({
        transactionId: txId,
        reference,
        status: tx.status ?? null,
        amount: tx.amount_in_cents ? tx.amount_in_cents / 100 : 0,
        currency: tx.currency ?? 'COP',
        customerEmail: tx.customer_email ?? null,
        paymentMethodType: tx.payment_method_type ?? null,
        wompiCreatedAt: tx.created_at ?? null,
        paymentRequest: paymentRequest
          ? {
              _id: String(paymentRequest._id),
              reference: paymentRequest.reference,
              status: paymentRequest.status,
            }
          : null,
        organizationUser: ou
          ? {
              _id: String(ou._id),
              email: ou.properties?.email ?? null,
              identification,
              firstName:
                ou.properties?.nombres ??
                ou.properties?.firstName ??
                ou.properties?.name ??
                null,
              lastName:
                ou.properties?.apellidos ?? ou.properties?.lastName ?? null,
            }
          : null,
        paymentPlan: paymentPlan
          ? {
              _id: String(paymentPlan._id),
              status: new Date(paymentPlan.date_until) >= now ? 'active' : 'expired',
              date_until: paymentPlan.date_until,
              price: paymentPlan.price,
              source: paymentPlan.source,
            }
          : null,
        matchedBy,
        dbStatus,
      });
    }

    // ── Planes sin ninguna transacción Wompi vinculada ────────────────────────

    const plansWithoutWompi: PlanWithoutWompiRow[] = allPlans
      .filter((plan) => !matchedPlanIds.has(String(plan._id)))
      .map((plan) => {
        const ou = plan.orgUser;
        const identification =
          ou?.properties?.ID ??
          ou?.properties?.cedula ??
          ou?.properties?.identificacion ??
          ou?.properties?.documento ??
          null;
        return {
          paymentPlanId: String(plan._id),
          organizationUserId: String(plan.organization_user_id),
          email: ou?.properties?.email ?? null,
          identification,
          firstName:
            ou?.properties?.nombres ??
            ou?.properties?.firstName ??
            ou?.properties?.name ??
            null,
          lastName: ou?.properties?.apellidos ?? ou?.properties?.lastName ?? null,
          source: plan.source,
          status: new Date(plan.date_until) >= now ? 'active' : 'expired',
          date_until: plan.date_until,
          price: plan.price,
          transactionId: plan.transactionId ?? null,
          payment_request_id: plan.payment_request_id
            ? String(plan.payment_request_id)
            : null,
          created_at: plan.created_at,
        };
      });

    return {
      summary: {
        wompiTotal: wompiTransactions.length,
        fullyLinked: wompiRows.filter((r) => r.dbStatus === 'fully_linked').length,
        hasUserNoPlan: wompiRows.filter((r) => r.dbStatus === 'has_user_no_plan').length,
        noDbMatch: wompiRows.filter((r) => r.dbStatus === 'no_db_match').length,
        matchedPlans: matchedPlanIds.size,
        plansWithoutWompi: plansWithoutWompi.length,
        totalPlans: allPlans.length,
        generatedAt: now,
      },
      wompiTransactions: wompiRows,
      plansWithoutWompi,
    };
  }

  /**
   * Clasifica TODOS los usuarios de la org según su historial de pago real.
   *
   * Usa únicamente datos de la BD (PaymentPlans + PaymentRequests APPROVED)
   * — no requiere consultar la API de Wompi en tiempo real.
   *
   * Para distinguir pago original vs pago de renovación compara la fecha del
   * PaymentRequest contra el período original del plan:
   *   período original = [plan.created_at, plan.created_at + plan.days]
   *
   * Categorías:
   *  pagado_sin_renovar         Pagó original, aún sin renovar
   *  pagado_renovado_pagando    Pagó original + renovó pagando
   *  pagado_renovado_cortesia   Pagó original + renovaron sin cobro
   *  cortesia_sin_renovar       Membresía cortesía, sin renovar
   *  cortesia_renovada_pagando  Cortesía original + renovó pagando
   *  cortesia_renovada_cortesia Cortesía + renovó con cortesía
   *  sin_plan                   Sin suscripción
   */
  /**
   * Clasifica TODOS los usuarios de la org usando transacciones reales de Wompi
   * como fuente de verdad (pasadas desde el controller que ya las fetcheó).
   *
   * Matching de transacción → usuario (en orden de confianza):
   *  1. customer_email → OrganizationUser.properties.email
   *  2. reference      → PaymentRequest → userId → OrganizationUser
   *  3. transactionId  → PaymentPlan.transactionId (cron_approved)
   *
   * Para cada pago se determina si cayó en el período original del plan
   * (created_at + days) o en un período de renovación.
   */
  async getFullSubscriptionClassification(
    wompiTransactions: any[],
    organizationId: string,
  ): Promise<FullClassificationResult> {
    const orgObjectId = new Types.ObjectId(organizationId);
    const now = new Date();
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    // ── Pre-carga de datos de BD ──────────────────────────────────────────────

    const allOrgUsers = await this.organizationUserModel
      .find({ organization_id: orgObjectId })
      .lean();

    const allPlans: any[] = await this.paymentPlanModel.aggregate([
      {
        $lookup: {
          from: this.organizationUserModel.collection.name,
          localField: 'organization_user_id',
          foreignField: '_id',
          as: 'orgUser',
        },
      },
      { $unwind: '$orgUser' },
      { $match: { 'orgUser.organization_id': orgObjectId } },
    ]);

    // PaymentRequests solo para el matching reference → userId
    const allPRs = await this.paymentRequestModel
      .find({ organizationId })
      .select('reference userId transactionId')
      .lean();

    const prByReference = new Map<string, any>();
    const prByTransactionId = new Map<string, any>();
    for (const pr of allPRs) {
      if (pr.reference) prByReference.set(pr.reference, pr);
      if (pr.transactionId) prByTransactionId.set(pr.transactionId, pr);
    }

    // Para usuarios con múltiples planes, tomar siempre el más relevante:
    // 1. activo (date_until >= now) con date_until más lejana
    // 2. si todos vencidos, el de date_until más reciente
    const planByOrgUserId = new Map<string, any>();
    const planByTransactionId = new Map<string, any>();
    for (const plan of allPlans) {
      const key = String(plan.organization_user_id);
      const existing = planByOrgUserId.get(key);
      if (!existing) {
        planByOrgUserId.set(key, plan);
      } else {
        const existingUntil = new Date(existing.date_until).getTime();
        const candidateUntil = new Date(plan.date_until).getTime();
        const nowMs = now.getTime();
        const existingActive = existingUntil >= nowMs;
        const candidateActive = candidateUntil >= nowMs;
        // Prefiere activo sobre vencido; si ambos igual estado, el de date_until más lejana
        if (
          (!existingActive && candidateActive) ||
          (existingActive === candidateActive && candidateUntil > existingUntil)
        ) {
          planByOrgUserId.set(key, plan);
        }
      }
      if (plan.transactionId) planByTransactionId.set(plan.transactionId, plan);
    }

    const orgUserById = new Map<string, any>();
    const orgUserByEmail = new Map<string, any>();
    const orgUserByUserId = new Map<string, any>();
    for (const ou of allOrgUsers) {
      orgUserById.set(String(ou._id), ou);
      orgUserByUserId.set(String(ou.user_id), ou);
      const email = (ou.properties?.email ?? '').toLowerCase().trim();
      if (email) orgUserByEmail.set(email, ou);
    }

    // ── Agrupar transacciones Wompi por orgUserId ─────────────────────────────
    // Cada transacción se asocia al usuario usando los 3 niveles de matching.

    const txsByOrgUserId = new Map<string, any[]>();

    const addTx = (orgUserId: string, tx: any) => {
      if (!txsByOrgUserId.has(orgUserId)) txsByOrgUserId.set(orgUserId, []);
      // Deduplicar por transactionId
      const list = txsByOrgUserId.get(orgUserId)!;
      if (!list.some((t) => t.id === tx.id)) list.push(tx);
    };

    const unmatchedWompiTransactions: { transactionId: string; customerEmail: string | null; reference: string | null; amount: number; createdAt: string | null }[] = [];

    for (const tx of wompiTransactions) {
      const email = (tx.customer_email ?? '').toLowerCase().trim();
      let matched = false;

      // Nivel 1: email → OrganizationUser
      if (email && orgUserByEmail.has(email)) {
        addTx(String(orgUserByEmail.get(email)!._id), tx);
        matched = true;
      }

      // Nivel 2: reference → PaymentRequest → userId → OrganizationUser
      if (!matched && tx.reference) {
        const pr = prByReference.get(tx.reference) ?? prByTransactionId.get(tx.id);
        if (pr) {
          const ou = orgUserByUserId.get(pr.userId);
          if (ou) { addTx(String(ou._id), tx); matched = true; }
        }
      }

      // Nivel 3: transactionId → PaymentPlan → OrganizationUser
      if (!matched && tx.id && planByTransactionId.has(tx.id)) {
        const plan = planByTransactionId.get(tx.id);
        addTx(String(plan.organization_user_id), tx);
        matched = true;
      }

      if (!matched) {
        unmatchedWompiTransactions.push({
          transactionId: tx.id ?? null,
          customerEmail: tx.customer_email ?? null,
          reference: tx.reference ?? null,
          amount: tx.amount_in_cents ? tx.amount_in_cents / 100 : 0,
          createdAt: tx.created_at ?? null,
        });
      }
    }

    // ── Clasificación por usuario ─────────────────────────────────────────────

    const summary: FullClassificationSummary = {
      pagado_sin_renovar: 0,
      pagado_renovado_pagando: 0,
      pagado_renovado_cortesia: 0,
      cortesia_sin_renovar: 0,
      cortesia_renovada_pagando: 0,
      cortesia_renovada_cortesia: 0,
      sin_plan: 0,
      total: 0,
      generatedAt: now,
      totalWithPlan: 0,
      totalActive: 0,
      totalExpired: 0,
      totalRenewed: 0,
      totalNotRenewed: 0,
      renewedActive: 0,
      renewedExpired: 0,
      notRenewedActive: 0,
      notRenewedExpired: 0,
      totalRenewed_conWompi: 0,
      totalRenewed_sinWompi: 0,
      totalNotRenewed_conWompi: 0,
      totalNotRenewed_sinWompi: 0,
      renewedActive_conWompi: 0,
      renewedActive_sinWompi: 0,
      renewedExpired_conWompi: 0,
      renewedExpired_sinWompi: 0,
      notRenewedActive_conWompi: 0,
      notRenewedActive_sinWompi: 0,
      notRenewedExpired_conWompi: 0,
      notRenewedExpired_sinWompi: 0,
      totalConWompi: 0,
      totalSinWompi: 0,
      activePagaron: 0,
      activeCortesia: 0,
      activePagaron_sinRenovar: 0,
      activePagaron_renovaronPagando: 0,
      activePagaron_renovaronCortesia: 0,
      activePagaron_cortesiaRenovoPagando: 0,
      activeCortesia_sinRenovar: 0,
      activeCortesia_renovaronCortesia: 0,
      expiredConWompi: 0,
      expiredSinWompi: 0,
    };

    const items: ClassificationItem[] = allOrgUsers.map((ou) => {
      const plan = planByOrgUserId.get(String(ou._id));

      const identification =
        ou.properties?.ID ??
        ou.properties?.cedula ??
        ou.properties?.identificacion ??
        ou.properties?.documento ??
        null;

      const base = {
        organizationUserId: String(ou._id),
        email: ou.properties?.email ?? null,
        identification,
        firstName:
          ou.properties?.nombres ?? ou.properties?.firstName ?? ou.properties?.name ?? null,
        lastName: ou.properties?.apellidos ?? ou.properties?.lastName ?? null,
      };

      if (!plan) {
        summary.sin_plan++;
        return { ...base, paymentPlan: null, wompiPayments: [], classification: 'sin_plan' };
      }

      const createdAt = new Date(plan.created_at);
      const dateUntil = new Date(plan.date_until);
      const originalPeriodEnd = new Date(
        createdAt.getTime() + plan.days * MS_PER_DAY + MS_PER_DAY,
      );
      const isRenewed = dateUntil > originalPeriodEnd;

      // Transacciones Wompi de este usuario
      const userTxs = txsByOrgUserId.get(String(ou._id)) ?? [];

      const wompiPayments: ClassificationWompiPayment[] = userTxs.map((tx) => {
        const paymentDate: Date | null = tx.created_at ? new Date(tx.created_at) : null;
        return {
          transactionId: tx.id ?? null,
          reference: tx.reference ?? null,
          amount: tx.amount_in_cents ? tx.amount_in_cents / 100 : 0,
          paymentDate,
          isOriginalPeriod: paymentDate ? paymentDate <= originalPeriodEnd : false,
        };
      });

      const hasOriginalPayment = wompiPayments.some((p) => p.isOriginalPeriod);
      const hasRenewalPayment = wompiPayments.some((p) => !p.isOriginalPeriod);
      const hasAnyPayment = wompiPayments.length > 0;

      let classification: SubscriptionClassification;
      if (!isRenewed) {
        classification = hasAnyPayment ? 'pagado_sin_renovar' : 'cortesia_sin_renovar';
      } else if (hasOriginalPayment && hasRenewalPayment) {
        classification = 'pagado_renovado_pagando';
      } else if (hasOriginalPayment) {
        classification = 'pagado_renovado_cortesia';
      } else if (hasRenewalPayment) {
        classification = 'cortesia_renovada_pagando';
      } else {
        classification = 'cortesia_renovada_cortesia';
      }

      summary[classification]++;

      return {
        ...base,
        paymentPlan: {
          _id: String(plan._id),
          status: dateUntil >= now ? 'active' : 'expired',
          date_until: plan.date_until,
          price: plan.price,
          source: plan.source,
          created_at: plan.created_at,
          days: plan.days,
          isRenewed,
        },
        wompiPayments,
        classification,
      };
    });

    // ── Métricas jerárquicas derivadas de los items ───────────────────────
    for (const item of items) {
      const isActive = item.paymentPlan?.status === 'active';
      const isExpired = item.paymentPlan?.status === 'expired';
      const isRenewed = item.paymentPlan?.isRenewed ?? false;
      const c = item.classification;
      // Fuente de verdad: tiene pago Wompi si wompiPayments.length > 0
      const hasWompi = item.wompiPayments.length > 0;

      if (c !== 'sin_plan') {
        summary.totalWithPlan++;
        if (isActive) summary.totalActive++;
        if (isExpired) summary.totalExpired++;

        // Renovación sobre TODOS con plan × estado × fuente de pago
        if (isRenewed) {
          summary.totalRenewed++;
          if (isActive) summary.renewedActive++;
          if (isExpired) summary.renewedExpired++;
          if (hasWompi) {
            summary.totalRenewed_conWompi++;
            if (isActive) summary.renewedActive_conWompi++;
            if (isExpired) summary.renewedExpired_conWompi++;
          } else {
            summary.totalRenewed_sinWompi++;
            if (isActive) summary.renewedActive_sinWompi++;
            if (isExpired) summary.renewedExpired_sinWompi++;
          }
        } else {
          summary.totalNotRenewed++;
          if (isActive) summary.notRenewedActive++;
          if (isExpired) summary.notRenewedExpired++;
          if (hasWompi) {
            summary.totalNotRenewed_conWompi++;
            if (isActive) summary.notRenewedActive_conWompi++;
            if (isExpired) summary.notRenewedExpired_conWompi++;
          } else {
            summary.totalNotRenewed_sinWompi++;
            if (isActive) summary.notRenewedActive_sinWompi++;
            if (isExpired) summary.notRenewedExpired_sinWompi++;
          }
        }

        // Histórico total (activos + vencidos) — comparable con reconciliación Wompi
        if (hasWompi) summary.totalConWompi++;
        else summary.totalSinWompi++;

        if (isActive) {

          // "Pagaron con Wompi" = tiene al menos 1 pago Wompi (cualquier período)
          if (hasWompi) {
            summary.activePagaron++;
            if (c === 'pagado_sin_renovar') summary.activePagaron_sinRenovar++;
            else if (c === 'pagado_renovado_pagando') summary.activePagaron_renovaronPagando++;
            else if (c === 'pagado_renovado_cortesia') summary.activePagaron_renovaronCortesia++;
            else if (c === 'cortesia_renovada_pagando') summary.activePagaron_cortesiaRenovoPagando++;
          } else {
            // Sin ningún pago Wompi
            summary.activeCortesia++;
            if (c === 'cortesia_sin_renovar') summary.activeCortesia_sinRenovar++;
            else if (c === 'cortesia_renovada_cortesia') summary.activeCortesia_renovaronCortesia++;
          }
        }

        if (isExpired) {
          if (hasWompi) summary.expiredConWompi++;
          else summary.expiredSinWompi++;
        }
      }
    }

    summary.total = allOrgUsers.length;
    summary.generatedAt = now;

    return { summary, items, unmatchedWompiTransactions };
  }
}
