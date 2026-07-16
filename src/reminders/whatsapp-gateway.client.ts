import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';

export interface SendTemplatePayload {
  to: string;
  templateName: string;
  parameters: string[];
  languageCode?: string;
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
  private readonly logger = new Logger(WhatsappGatewayClient.name);

  private readonly gatewayUrl: string;
  private readonly accountId: string;
  private readonly phoneNumberId: string;
  private readonly accessToken: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.gatewayUrl = this.configService.get<string>('WHATSAPP_GATEWAY_URL');
    this.accountId =
      this.configService.get<string>('WHATSAPP_GATEWAY_ACCOUNT_ID') ||
      'gencampus';
    this.phoneNumberId = this.configService.get<string>(
      'WHATSAPP_GATEWAY_PHONE_NUMBER_ID',
    );
    this.accessToken = this.configService.get<string>(
      'WHATSAPP_GATEWAY_ACCESS_TOKEN',
    );
  }

  get isConfigured(): boolean {
    return Boolean(this.gatewayUrl);
  }

  /**
   * Se re-registra la cuenta en cada corrida para que un cambio de token
   * en .env solo requiera reiniciar el backend.
   */
  async registerAccount(): Promise<void> {
    if (!this.phoneNumberId || !this.accessToken) {
      this.logger.warn(
        'WHATSAPP_GATEWAY_PHONE_NUMBER_ID/ACCESS_TOKEN no configurados, se omite el registro de cuenta',
      );
      return;
    }
    try {
      await lastValueFrom(
        this.httpService.post(`${this.gatewayUrl}/api/account/register`, {
          accountId: this.accountId,
          phoneNumberId: this.phoneNumberId,
          accessToken: this.accessToken,
        }),
      );
    } catch (error) {
      this.logger.error(
        `No se pudo registrar la cuenta '${this.accountId}' en el gateway de WhatsApp: ${
          (error as any)?.message || error
        }`,
      );
    }
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
