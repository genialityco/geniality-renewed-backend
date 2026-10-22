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

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  rejected_reason?: string;
}

export interface SendOutcome {
  result: 'sent' | 'fallback_email';
  /** wamid del mensaje en WhatsApp (null si salió por email) */
  messageId: string | null;
}

function messageIdOf(response: { data?: any } | undefined): string | null {
  const id = response?.data?.messageId;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Cliente del gateway externo de WhatsApp (wa-multisession-backend).
 * Compartido por los recordatorios de inactividad y el reporte semanal.
 */
@Injectable()
export class WhatsappGatewayClient {
  private readonly gatewayUrl: string;
  private readonly accountId: string;
  // CAMPAIGN_API_KEY del gateway: lo exigen los endpoints de plantillas y el
  // envío con componentes (Gen.ON)
  private readonly apiKey: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.gatewayUrl = this.configService.get<string>('WHATSAPP_GATEWAY_URL');
    this.accountId =
      this.configService.get<string>('WHATSAPP_GATEWAY_ACCOUNT_ID') ||
      'gencampus';
    this.apiKey =
      this.configService.get<string>('WHATSAPP_GATEWAY_API_KEY') || '';
  }

  get isConfigured(): boolean {
    return Boolean(this.gatewayUrl);
  }

  /** Plantillas y envío con componentes requieren además la API key. */
  get hasTemplateApi(): boolean {
    return Boolean(this.gatewayUrl && this.apiKey);
  }

  private get apiKeyHeaders() {
    return { headers: { 'x-api-key': this.apiKey } };
  }

  /**
   * Envía una plantilla con los componentes ya armados (cuerpo, botones URL
   * y quick replies con payload). Devuelve el wamid. Lanza si Meta rechaza.
   */
  async sendTemplateComponents(payload: {
    to: string;
    templateName: string;
    languageCode: string;
    components: unknown[];
  }): Promise<SendOutcome> {
    const response = await lastValueFrom(
      this.httpService.post(
        `${this.gatewayUrl}/api/campaign/send`,
        payload,
        this.apiKeyHeaders,
      ),
    );
    return { result: 'sent', messageId: messageIdOf(response) };
  }

  /** Crea una plantilla en Meta (queda en revisión). */
  async createTemplate(template: {
    name: string;
    language: string;
    category: string;
    components: unknown[];
  }): Promise<{ id?: string; status?: string; category?: string }> {
    const response = await lastValueFrom(
      this.httpService.post(
        `${this.gatewayUrl}/api/templates`,
        template,
        this.apiKeyHeaders,
      ),
    );
    return response.data || {};
  }

  /** Todas las plantillas de la cuenta con su estado en Meta. */
  async listTemplates(): Promise<MetaTemplate[]> {
    const response = await lastValueFrom(
      this.httpService.get(`${this.gatewayUrl}/api/templates`, {
        ...this.apiKeyHeaders,
        params: { status: 'all' },
      }),
    );
    return response.data?.templates || [];
  }

  /**
   * Envía una plantilla. El gateway responde 500 cuando WhatsApp falla,
   * pero indica si alcanzó a enviar el email de respaldo; en ese caso se
   * devuelve 'fallback_email' en lugar de propagar el error.
   */
  async sendTemplate(
    payload: SendTemplatePayload,
  ): Promise<'sent' | 'fallback_email'> {
    return (await this.sendTemplateWithId(payload)).result;
  }

  /**
   * Igual que sendTemplate, pero devuelve además el id del mensaje en
   * WhatsApp (wamid), con el que llegan después sus estados de entrega.
   */
  async sendTemplateWithId(payload: SendTemplatePayload): Promise<SendOutcome> {
    try {
      const response = await lastValueFrom(
        this.httpService.post(`${this.gatewayUrl}/api/send-template`, {
          accountId: this.accountId,
          languageCode: 'es',
          ...payload,
        }),
      );
      return { result: 'sent', messageId: messageIdOf(response) };
    } catch (error) {
      if ((error as any)?.response?.data?.fallbackEmailSent === true) {
        return { result: 'fallback_email', messageId: null };
      }
      throw error;
    }
  }

  /**
   * Envía un mensaje de texto libre (Cloud API). Solo funciona dentro de la
   * ventana de 24 h desde el último mensaje del usuario, p. ej. al responder
   * en una conversación iniciada por él. Devuelve el wamid si el gateway lo
   * informa.
   */
  async sendText(to: string, message: string): Promise<string | null> {
    const response = await lastValueFrom(
      this.httpService.post(`${this.gatewayUrl}/api/send-text`, {
        accountId: this.accountId,
        to,
        message,
      }),
    );
    return messageIdOf(response);
  }

  /**
   * Envía botones de respuesta (máx. 3, títulos de 20 caracteres) o una lista
   * (máx. 10 filas). Igual que sendText, solo dentro de la ventana de 24 h.
   * La respuesta del usuario llega al webhook de entrada con `replyId`.
   */
  async sendInteractive(
    to: string,
    message: InteractiveMessage,
  ): Promise<string | null> {
    const response = await lastValueFrom(
      this.httpService.post(`${this.gatewayUrl}/api/send-interactive`, {
        accountId: this.accountId,
        to,
        ...message,
      }),
    );
    return messageIdOf(response);
  }

  /** Envía un mensaje de texto o interactivo según su forma. */
  async sendOutbound(
    to: string,
    message: OutboundMessage,
  ): Promise<string | null> {
    if (typeof message === 'string') return this.sendText(to, message);
    if (message.buttons?.length || message.list?.sections?.length) {
      return this.sendInteractive(to, message);
    }
    return this.sendText(to, message.body);
  }
}

export interface InteractiveMessage {
  body: string;
  header?: string;
  footer?: string;
  buttons?: { id: string; title: string }[];
  list?: {
    button: string;
    sections: {
      title?: string;
      rows: { id: string; title: string; description?: string }[];
    }[];
  };
}

/** Mensaje saliente de un bot: texto plano o interactivo. */
export type OutboundMessage = string | InteractiveMessage;
