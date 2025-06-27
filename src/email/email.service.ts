import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as AWS from 'aws-sdk';

@Injectable()
export class EmailService {
  private ses: AWS.SES;
  private readonly logger = new Logger(EmailService.name);
  private readonly from: string;

  constructor(private configService: ConfigService) {
    this.ses = new AWS.SES({
      region: this.configService.get<string>('AWS_REGION'),
      accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID'),
      secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY'),
    });
    this.from = this.configService.get<string>('AWS_SES_EMAIL_FROM');
  }

  async sendEmail(to: string, subject: string, html: string) {
    const fromName = 'EndoCampus'; // Cambia esto
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
}
