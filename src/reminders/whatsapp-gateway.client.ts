import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';

export interface SendTemplatePayload {
  to: string;
  templateName: string;
  parameters: string[];
  languageCode?: string;
  // Sufijo dinámico del botón de la plantilla (ej. "<orgId>/course/<id>").
  // La plantilla de WhatsApp ya tiene fijo el dominio + "/organization/" en
  // el botón, así que acá NO va la URL completa (duplicaría el dominio) ni
  // como último elemento de "parameters".
  buttonUrl?: string;
  // Si WhatsApp falla, el gateway envía este email como respaldo
  // (requiere fallbackEmail + fallbackSubject + fallbackHtml)
  fallbackEmail?: string;
  fallbackSubject?: string;
  fallbackHtml?: string;
}

/**
 * Cliente del gateway externo de WhatsApp (wa-multisession-backend).
 * Compartido por los recordatorios de inactividad y el reporte semanal.
 */
@Injectable()
export class WhatsappGatewayClient {
  private readonly gatewayUrl: string;
  private readonly accountId: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.gatewayUrl = this.configService.get<string>('WHATSAPP_GATEWAY_URL');
    this.accountId =
      this.configService.get<string>('WHATSAPP_GATEWAY_ACCOUNT_ID') ||
      'gencampus';
  }

  get isConfigured(): boolean {
    return Boolean(this.gatewayUrl);
  }

  /**
   * Envía una plantilla. El gateway responde 500 cuando WhatsApp falla,
   * pero indica si alcanzó a enviar el email de respaldo; en ese caso se
   * devuelve 'fallback_email' en lugar de propagar el error.
   */
  async sendTemplate(
    payload: SendTemplatePayload,
  ): Promise<'sent' | 'fallback_email'> {
    try {
      await lastValueFrom(
        this.httpService.post(`${this.gatewayUrl}/api/send-template`, {
          accountId: this.accountId,
          languageCode: 'es',
          ...payload,
        }),
      );
      return 'sent';
    } catch (error) {
      if ((error as any)?.response?.data?.fallbackEmailSent === true) {
        return 'fallback_email';
      }
      throw error;
    }
  }
}
