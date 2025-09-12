// wompi.reconcile.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentRequestsService } from '../payment-requests/payment-requests.service';
import { WompiService } from './wompi.service';

@Injectable()
export class WompiReconcile {
  private readonly logger = new Logger(WompiReconcile.name);
  private readonly STALE_MINUTES = Number(
    process.env.WOMPI_RECONCILE_MINUTES ?? 10,
  );

  constructor(
    private readonly pr: PaymentRequestsService,
    private readonly wompi: WompiService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async run() {
    try {
      const pendings = await this.pr.listStalePendings(this.STALE_MINUTES);
      if (!pendings.length) return;

      this.logger.log(`Reconciliando ${pendings.length} payment requests...`);

      for (const p of pendings) {
        try {
          // Si no tenemos transactionId, no forzamos nada (espera webhook o success sync)
          if (!p.transactionId) {
            this.logger.debug(`PR ${p.reference} sin transactionId; skip`);
            continue;
          }

          const tx = (await this.wompi.getTransaction(p.transactionId)) as {
            status?: string;
            reference: string;
            id: string;
            amount_in_cents: number;
          };

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
            continue;
          }

          await this.pr.safeUpdateStatus({
            reference: tx.reference,
            nextStatus,
            transactionId: tx.id,
            source: 'poll',
          });

          if (nextStatus === 'APPROVED') {
            // Cargar el PaymentRequest completo (no lean) para activar membresía
            const full = await this.pr.findByReference(tx.reference);
            if (full) {
              await this.pr.activateMembershipForPayment(
                full,
                tx.amount_in_cents / 100,
              );
            }
          }
        } catch (e: any) {
          this.logger.warn(
            `Error reconciliando ${p.reference}: ${e?.message || e}`,
          );
        }
      }
    } catch (e: any) {
      this.logger.error(`Fallo reconciliación: ${e?.message || e}`);
    }
  }
}
