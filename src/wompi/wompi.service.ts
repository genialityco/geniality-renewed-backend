// src/wompi/wompi.service.ts
import { Injectable } from '@nestjs/common';
// import fetch from 'node-fetch';

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
  private readonly isProd = process.env.WOMPI_ENV === 'production';

  private readonly base = this.isProd
    ? 'https://production.wompi.co/v1'
    : 'https://api-sandbox.wompi.co/v1';

  private readonly privateKey = this.isProd
    ? process.env.WOMPI_PRIVATE_KEY_PROD
    : process.env.WOMPI_PRIVATE_KEY_TEST;

  constructor() {
    const key = this.privateKey ?? '';
    const prodHost = this.base.includes('production.wompi.co');
    const sandboxHost = this.base.includes('api-sandbox.wompi.co');
    const testKey = key.startsWith('prv_test_');
    const liveKey = key.startsWith('prv_live_');
    if ((prodHost && testKey) || (sandboxHost && liveKey)) {
      throw new Error(
        `[WOMPI CONFIG] Inconsistencia: base=${this.base} con key tipo ${testKey ? 'TEST' : 'LIVE'}`,
      );
    }
  }

  private get authHeader() {
    if (!this.privateKey) throw new Error('WOMPI private key no configurada');
    return `Bearer ${this.privateKey}`;
  }

  async getTransaction(id: string): Promise<WompiTxn> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000); // 10s timeout

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
        // Wompi suele devolver { error: { type, reason, messages } }
        const msg =
          (body?.error?.reason as string) ||
          body?.error?.messages?.join?.(', ') ||
          `HTTP ${res.status}`;
        throw new Error(`Wompi: ${msg}`);
      }
      return body as WompiTxn;
    } finally {
      clearTimeout(t);
    }
  }
}
