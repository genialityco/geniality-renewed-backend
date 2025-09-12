// src/wompi/wompi.service.ts
import { Injectable } from '@nestjs/common';
import fetch from 'node-fetch';

@Injectable()
export class WompiService {
  private base = 'https://production.wompi.co/v1';
  private auth = `Bearer ${process.env.WOMPI_PRIVATE_KEY!}`;

  async getTransaction(id: string) {
    const res = await fetch(`${this.base}/transactions/${id}`, {
      headers: { Authorization: this.auth },
    });
    if (!res.ok) throw new Error(`Wompi ${res.status}`);
    return res.json(); // retorna { data: { id, status, amount_in_cents, reference, ... } }
  }
}
