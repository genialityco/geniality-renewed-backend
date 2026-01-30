// src/wompi/wompi.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PaymentLogsService } from 'src/payment-logs/payment-logs.service';

type WompiTxn = {
  data: {
    id: string;
    status: 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR' | 'PENDING';
    amount_in_cents: number;
    reference: string;
    payment_method_type?: string;
  };
};

@Injectable()
export class WompiService {
  private readonly logger = new Logger(WompiService.name);

  private readonly isProd = process.env.WOMPI_ENV === 'production';

  private readonly base = this.isProd
    ? 'https://production.wompi.co/v1'
    : 'https://api-sandbox.wompi.co/v1';

  private readonly privateKey = this.isProd
    ? process.env.WOMPI_PRIVATE_KEY_PROD
    : process.env.WOMPI_PRIVATE_KEY_TEST;

  constructor(private readonly paymentLogs: PaymentLogsService) {
    const key = this.privateKey ?? '';
    const prodHost = this.base.includes('production.wompi.co');
    const sandboxHost = this.base.includes('api-sandbox.wompi.co');
    const testKey = key.startsWith('prv_test_');
    const liveKey = key.startsWith('prv_live_');
    if ((prodHost && testKey) || (sandboxHost && liveKey)) {
      throw new Error(
        `[WOMPI CONFIG] Inconsistencia: base=${this.base} con key tipo ${
          testKey ? 'TEST' : 'LIVE'
        }`,
      );
    }
  }

  /**
   * Obtiene transacciones por rango de fechas, paginado y filtrado por status.
   * Retorna el body crudo de Wompi ({ data: [...], meta: { page, page_size, total_results } }).
   */
  async getTransactions(opts: {
    from_date: string;
    until_date: string;
    page?: number;
    page_size?: number;
    status?: string;
  }): Promise<any> {
    const { from_date, until_date, page = 1, page_size = 50, status } = opts;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);

    await this.paymentLogs.write({
      level: 'info',
      message: 'Wompi.getTransactions: inicio',
      source: 'wompi-api',
      meta: { from_date, until_date, page, page_size, status, env: this.isProd ? 'prod' : 'sandbox' },
    });

    try {
      const qs = new URLSearchParams();
      qs.set('from_date', from_date);
      qs.set('until_date', until_date);
      qs.set('page', String(page));
      qs.set('page_size', String(page_size));
      if (status) qs.set('status', status);

      const url = `https://production.wompi.co/v1/transactions?${qs.toString()}`;
      this.logger.log(`Wompi.getTransactions: fetch ${url}`);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.WOMPI_PRIVATE_KEY_PROD}` }, signal: ctrl.signal });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg = (body?.error?.reason as string) || body?.error?.messages?.join?.(', ') || `HTTP ${res.status}`;
        await this.paymentLogs.write({ level: 'error', message: 'Wompi.getTransactions: HTTP error', source: 'wompi-api', meta: { statusCode: res.status, msg } });
        throw new Error(`Wompi: ${msg}`);
      }

      await this.paymentLogs.write({ level: 'info', message: 'Wompi.getTransactions: éxito', source: 'wompi-api', meta: { page: body?.meta?.page, page_size: body?.meta?.page_size, total_results: body?.meta?.total_results } });

      return body;
    } catch (err: any) {
      const isAbort = err.name === 'AbortError';
      const level = isAbort ? 'warn' : 'error';
      const msg = isAbort ? 'timeout/abort' : err.message;
      await this.paymentLogs.write({ level, message: 'Wompi.getTransactions: fallo', source: 'wompi-api', meta: { error: msg } });
      this.logger.warn(`Error en getTransactions(${from_date},${until_date}): ${msg}`);
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  private get authHeader() {
    if (!this.privateKey) throw new Error('WOMPI private key no configurada');
    return `Bearer ${this.privateKey}`;
  }

  async getTransaction(id: string): Promise<WompiTxn> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000); // 10s timeout

    // Log: inicio del fetch
    await this.paymentLogs.write({
      level: 'info',
      message: 'Wompi.getTransaction: inicio',
      source: 'wompi-api',
      transactionId: id,
      meta: { env: this.isProd ? 'prod' : 'sandbox' },
    });

    try {
      const res = await fetch(
        `${this.base}/transactions/${encodeURIComponent(id)}`,
        {
          headers: { Authorization: this.authHeader },
          signal: ctrl.signal,
        },
      );

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg =
          (body?.error?.reason as string) ||
          body?.error?.messages?.join?.(', ') ||
          `HTTP ${res.status}`;

        // Log de error HTTP de Wompi
        await this.paymentLogs.write({
          level: 'error',
          message: 'Wompi.getTransaction: HTTP error',
          source: 'wompi-api',
          transactionId: id,
          meta: {
            statusCode: res.status,
            msg,
            env: this.isProd ? 'prod' : 'sandbox',
          },
        });

        throw new Error(`Wompi: ${msg}`);
      }

      // Log: éxito
      await this.paymentLogs.write({
        level: 'info',
        message: 'Wompi.getTransaction: éxito',
        source: 'wompi-api',
        transactionId: body?.data?.id ?? id,
        reference: body?.data?.reference,
        status: body?.data?.status,
        amount: body?.data?.amount_in_cents
          ? body.data.amount_in_cents / 100
          : undefined,
        meta: { payment_method_type: body?.data?.payment_method_type },
      });

      return body as WompiTxn;
    } catch (err: any) {
      const isAbort = err.name === 'AbortError';
      const level = isAbort ? 'warn' : 'error';
      const msg = isAbort ? 'timeout/abort' : err.message;

      await this.paymentLogs.write({
        level,
        message: 'Wompi.getTransaction: fallo',
        source: 'wompi-api',
        transactionId: id,
        meta: { error: msg },
      });

      this.logger.warn(`Error en getTransaction(${id}): ${msg}`);
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
}
