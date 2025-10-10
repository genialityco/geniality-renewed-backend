// wompi.reconcile.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentRequestsService } from '../payment-requests/payment-requests.service';
import { WompiService } from './wompi.service';
import { PaymentLogsService } from 'src/payment-logs/payment-logs.service';

@Injectable()
export class WompiReconcile {
  private readonly logger = new Logger(WompiReconcile.name);
  private readonly STALE_MINUTES = Number(
    process.env.WOMPI_RECONCILE_MINUTES ?? 10,
  );

  constructor(
    private readonly pr: PaymentRequestsService,
    private readonly wompi: WompiService,
    private readonly paymentLogs: PaymentLogsService, // ← inyectamos logs
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async run() {
    try {
      const pendings = await this.pr.listStalePendings(this.STALE_MINUTES);

      if (!pendings.length) {
        await this.paymentLogs.write({
          level: 'info',
          message: 'reconcile: sin pendientes',
          source: 'reconcile',
          meta: { staleMinutes: this.STALE_MINUTES },
        });
        return;
      }

      this.logger.log(`Reconciliando ${pendings.length} payment requests...`);
      await this.paymentLogs.write({
        level: 'info',
        message: 'reconcile: inicio',
        source: 'reconcile',
        meta: { count: pendings.length, staleMinutes: this.STALE_MINUTES },
      });

      let processed = 0;
      let approvedActivated = 0;
      let skippedNoTx = 0;

      for (const p of pendings) {
        try {
          // 1) Skip si no hay transactionId
          if (!p.transactionId) {
            skippedNoTx++;
            this.logger.debug(`PR ${p.reference} sin transactionId; skip`);
            // await this.paymentLogs.write({
            //   level: 'warn',
            //   message: 'reconcile: PR sin transactionId (skip)',
            //   source: 'reconcile',
            //   reference: p.reference,
            // });
            continue;
          }

          // 2) Traer transacción de Wompi
          const txResp = (await this.wompi.getTransaction(
            p.transactionId,
          )) as any;
          const tx = txResp?.data as {
            status?: string;
            reference: string;
            id: string;
            amount_in_cents: number;
            currency?: string;
          };

          if (!tx || !tx.reference) {
            this.logger.warn(
              `Respuesta inválida de Wompi para txId=${p.transactionId}; skip`,
            );
            await this.paymentLogs.write({
              level: 'warn',
              message: 'reconcile: tx inválida/ sin reference (skip)',
              source: 'reconcile',
              transactionId: p.transactionId,
              meta: { txHasData: Boolean(txResp?.data) },
            });
            continue;
          }

          // 3) Validar/normalizar estado
          const allowedStatuses = [
            'CREATED',
            'PENDING',
            'APPROVED',
            'DECLINED',
            'VOIDED',
            'ERROR',
          ] as const;
          type AllowedStatus = (typeof allowedStatuses)[number];

          const nextStatus = (tx.status || '').toUpperCase() as AllowedStatus;
          if (!allowedStatuses.includes(nextStatus)) {
            this.logger.warn(
              `Estado no permitido (${nextStatus}) para PR ${tx.reference}; skip`,
            );
            await this.paymentLogs.write({
              level: 'warn',
              message: 'reconcile: estado no permitido (skip)',
              source: 'reconcile',
              reference: tx.reference,
              transactionId: tx.id,
              status: nextStatus,
            });
            continue;
          }

          // 4) Guardar snapshot + intentar transición
          const res = await this.pr.safeUpdateStatus({
            reference: tx.reference,
            nextStatus,
            transactionId: tx.id,
            source: 'reconcile',
            rawWompi: txResp,
          });

          processed++;

          if (!res.doc) {
            this.logger.warn(
              `No existe PaymentRequest con reference ${tx.reference}`,
            );
            await this.paymentLogs.write({
              level: 'warn',
              message: 'reconcile: PR inexistente tras safeUpdateStatus',
              source: 'reconcile',
              reference: tx.reference,
              transactionId: tx.id,
              status: nextStatus,
            });
            continue;
          }

          // 5) Log de estado actualizado
          await this.paymentLogs.write({
            level: 'info',
            message: 'reconcile: estado actualizado',
            source: 'reconcile',
            reference: res.doc.reference,
            transactionId: res.doc.transactionId,
            status: res.doc.status,
            amount: res.doc.amount,
            currency: res.doc.currency ?? 'COP',
            meta: { becameApproved: res.becameApproved },
          });

          // 6) Activar si está APPROVED (idempotente)
          if ((res.doc.status ?? '').toUpperCase() === 'APPROVED') {
            try {
              await this.pr.activateMembershipForPayment(
                res.doc,
                tx.amount_in_cents / 100,
              );
              approvedActivated++;

              this.logger.log(
                `Activada membresía por reconcile para reference=${tx.reference}`,
              );
              await this.paymentLogs.write({
                level: 'info',
                message: 'reconcile: PaymentPlan activado',
                source: 'reconcile',
                reference: res.doc.reference,
                transactionId: res.doc.transactionId,
                organizationId: res.doc.organizationId,
                userId: String(res.doc.userId),
                amount: tx.amount_in_cents / 100,
                currency: tx.currency ?? 'COP',
              });
            } catch (e) {
              this.logger.warn(
                `No se pudo activar plan para ${tx.reference}: ${e}`,
              );
              await this.paymentLogs.write({
                level: 'error',
                message: 'reconcile: fallo activando PaymentPlan',
                source: 'reconcile',
                reference: res.doc.reference,
                transactionId: res.doc.transactionId,
                organizationId: res.doc.organizationId,
                userId: String(res.doc.userId),
                amount: tx.amount_in_cents / 100,
                currency: tx.currency ?? 'COP',
                meta: { error: (e as any)?.message || String(e) },
              });
            }
          }
        } catch (e: any) {
          this.logger.warn(
            `Error reconciliando ${p.reference}: ${e?.message || e}`,
          );
          await this.paymentLogs.write({
            level: 'error',
            message: 'reconcile: error por PR en loop',
            source: 'reconcile',
            reference: p.reference,
            transactionId: p.transactionId,
            meta: { error: e?.message || String(e) },
          });
        }
      }

      // 7) Resumen de corrida
      await this.paymentLogs.write({
        level: 'info',
        message: 'reconcile: fin',
        source: 'reconcile',
        meta: {
          totalPendings: pendings.length,
          processed,
          approvedActivated,
          skippedNoTx,
          staleMinutes: this.STALE_MINUTES,
        },
      });
    } catch (e: any) {
      this.logger.error(`Fallo reconciliación: ${e?.message || e}`);
      await this.paymentLogs.write({
        level: 'error',
        message: 'reconcile: fallo global',
        source: 'reconcile',
        meta: { error: e?.message || String(e) },
      });
    }
  }
}
