import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as AWS from 'aws-sdk';

@Injectable()
export class EmailService {
  private ses: AWS.SES;
  private readonly logger = new Logger(EmailService.name);
  private readonly from: string;
  private readonly fromName: string;

  constructor(private configService: ConfigService) {
    this.ses = new AWS.SES({
      region: this.configService.get<string>('AWS_REGION'),
      accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID'),
      secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY'),
    });
    this.from = this.configService.get<string>('AWS_SES_EMAIL_FROM');
    this.fromName =
      this.configService.get<string>('AWS_SES_EMAIL_FROM_NAME') || 'No-Reply';
  }

  // Tu método anterior, si lo quieres conservar
  async sendEmail(to: string, subject: string, html: string) {
    const fromName = 'EndoCampus'; // Fijo
    const fromEmail = this.from;

    const params = {
      Source: `${fromName} <${fromEmail}>`,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: { Html: { Data: html } },
      },
    };

    try {
      const result = await this.ses.sendEmail(params).promise();
      this.logger.log(`Email enviado a ${to} (MessageId: ${result.MessageId})`);
      return result;
    } catch (error) {
      this.logger.error(`Error enviando email a ${to}: ${error.message}`);
      throw error;
    }
  }

  // NUEVO: Método universal y flexible
  async sendUniversalEmail(body: any) {
    const { to, cc, bcc, subject, html, fromName, fromEmail } = body;

    const finalFrom = fromEmail || this.from;
    const finalFromName = fromName || this.fromName;

    const params: AWS.SES.SendEmailRequest = {
      Source: `${finalFromName} <${finalFrom}>`,
      Destination: {
        ToAddresses: Array.isArray(to) ? to : [to],
        CcAddresses: cc ? (Array.isArray(cc) ? cc : [cc]) : [],
        BccAddresses: bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : [],
      },
      Message: {
        Subject: { Data: subject },
        Body: { Html: { Data: html } },
      },
    };

    try {
      const result = await this.ses.sendEmail(params).promise();
      this.logger.log(
        `[Universal] Email enviado a ${params.Destination.ToAddresses.join(', ')} (MessageId: ${result.MessageId})`,
      );
      return result;
    } catch (error) {
      this.logger.error(`[Universal] Error enviando email: ${error.message}`);
      throw error;
    }
  }
}
