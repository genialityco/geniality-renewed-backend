import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WompiService } from './wompi.service';
import { PaymentPlansService } from 'src/payment-plans/payment-plans.service';
import { OrganizationUsersService } from 'src/organization-users/organization-users.service';
import { PaymentLogsService } from 'src/payment-logs/payment-logs.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from 'src/users/schemas/user.schema';
import { PaymentPlan } from 'src/payment-plans/schemas/payment-plan.schema';

@Injectable()
export class WompiApprovedCron {
  private readonly logger = new Logger(WompiApprovedCron.name);
  private readonly PAGE_SIZE = 50;

  constructor(
    private readonly wompi: WompiService,
    private readonly orgUsersService: OrganizationUsersService,
    private readonly paymentPlansService: PaymentPlansService,
    private readonly paymentLogs: PaymentLogsService,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(PaymentPlan.name) private readonly paymentPlanModel: Model<PaymentPlan>,
  ) {}

  @Cron(CronExpression.EVERY_6_HOURS)
  async run() {
    const until = new Date();
    const from = new Date(Date.now() - 60 * 60 * 1000); // última hora
    const fromISO = from.toISOString();
    const untilISO = until.toISOString();
    
    await this.paymentLogs.write({
        level: 'info',
        message: 'approved-cron: inicio',
        source: 'service',
        meta: { from: fromISO, until: untilISO },
    });
    
    let page = 1;
    try {
        while (true) {
            this.logger.log(`approved-cron: desde ${from.toISOString()} hasta ${until.toISOString()}`);
            const body = await this.wompi.getTransactions({
          from_date: fromISO,
          until_date: untilISO,
          page,
          page_size: this.PAGE_SIZE,
          status: 'APPROVED',
        });

        const items = Array.isArray(body?.data) ? body.data : [];

        if (!items.length) break;
        for (const tx of items) {
          try {
            const email = tx?.customer_email;
            if (!email) {
              await this.paymentLogs.write({
                level: 'warn',
                message: 'approved-cron: tx sin customer_email',
                source: 'service',
                transactionId: tx.id,
                meta: { reference: tx.reference },
              });
              continue;
            }
             this.logger.log(`Email encontrado: ${email}`);

            // 1) Buscar usuario en users por email (case-insensitive)
            let userId: string | null = null;
            try {
              const pattern = `^${email.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}$`;
              const u = await this.userModel.findOne({ email: { $regex: pattern, $options: 'i' } }).select('_id').lean();
              if (u) userId = String((u as any)._id);
            } catch (e) {
              // ignore
            }

            if (!userId) {
              await this.paymentLogs.write({
                level: 'warn',
                message: 'approved-cron: user no encontrado por email',
                source: 'service',
                transactionId: tx.id,
                meta: { email, reference: tx.reference },
              });
              continue;
            }

            // 2) Buscar organizationUser por user_id
            const orgUser = await this.orgUsersService.findByUserId(userId).catch(() => null);
            if (!orgUser) {
              await this.paymentLogs.write({
                level: 'warn',
                message: 'approved-cron: organizationUser no encontrado',
                source: 'service',
                transactionId: tx.id,
                meta: { userId, email, reference: tx.reference },
              });
              continue;
            }

            // 3) Si tiene payment_plan_id, comprobar existencia por id en payment_plans
            const planId = orgUser.payment_plan_id;
            let planExists = false;
            if (planId) {
              try {
                const existingPlan = await this.paymentPlanModel.findById(planId).select('_id').lean();
                if (existingPlan) planExists = true;
              } catch (e) {
                planExists = false;
              }
            }

            // 4) Si no existe, crear plan (365 días, price 50000 por ejemplo)
            if (!planExists) {
              const days = 365;
              const date_until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
              const price = (tx.amount_in_cents ? tx.amount_in_cents / 100 : 50000) as number;

              const meta: { source: 'cron_approved'; reference: any; transactionId: any; currency: any; rawWebhook: any; payment_request_id: any } = {
                source: 'cron_approved',
                reference: tx.reference,
                transactionId: tx.id,
                currency: tx.currency ?? 'COP',
                rawWebhook: tx,
                payment_request_id: null,
              };

              const created = await this.paymentPlansService.createPaymentPlan(
                String(orgUser._id),
                days,
                date_until,
                price,
                orgUser?.properties?.nombres || orgUser?.properties?.names || undefined,
                meta,
              );

              // 5) Enlazar payment_plan_id en organizationUser
              await this.orgUsersService.updatePaymentPlanId(String(userId), String(created._id)).catch(() => null);

              await this.paymentLogs.write({
                level: 'info',
                message: 'approved-cron: paymentPlan creado y enlazado',
                source: 'service',
                transactionId: tx.id,
                reference: tx.reference,
                meta: { organizationUserId: String(orgUser._id), paymentPlanId: String(created._id), price },
              });
            } else {
              await this.paymentLogs.write({
                level: 'info',
                message: 'approved-cron: paymentPlan ya existente',
                source: 'service',
                transactionId: tx.id,
                reference: tx.reference,
                meta: { organizationUserId: String(orgUser._id), paymentPlanId: String(planId) },
              });
            }
          } catch (inner) {
            await this.paymentLogs.write({
              level: 'error',
              message: 'approved-cron: error procesando tx',
              source: 'service',
              transactionId: tx.id,
              meta: { error: (inner as any)?.message || String(inner), reference: tx.reference },
            });
          }
        }

        // paginación simple
        const total = Number(body?.meta?.total_results ?? 0);
        const page_size = Number(body?.meta?.page_size ?? this.PAGE_SIZE);
        const current_page = Number(body?.meta?.page ?? page);
        const maxPage = Math.ceil(total / page_size) || current_page;
        if (current_page >= maxPage) break;
        page++;
      }

      await this.paymentLogs.write({ level: 'info', message: 'approved-cron: fin', source: 'service' });
    } catch (e) {
      await this.paymentLogs.write({ level: 'error', message: 'approved-cron: fallo global', source: 'service', meta: { error: (e as any)?.message || String(e) } });
      this.logger.error('approved-cron fallo', e as any);
    }
  }
}
