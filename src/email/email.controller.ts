import { Controller, Post, Body } from '@nestjs/common';
import { EmailService } from './email.service';
import { renderWelcomeContent } from '../templates/Welcome';
import { renderSubscriptionContent } from 'src/templates/PaySuscription';

@Controller('email')
export class EmailController {
  constructor(private readonly emailService: EmailService) { }
  @Post('test')
  async sendTestEmail(
    @Body() body: { to: string; subject: string; html: string },
  ) {
    try {
      const result = await this.emailService.sendEmail(
        body.to,
        body.subject,
        body.html,
      );
      return {
        success: true,
        message: 'Email enviado correctamente',
        result,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Error enviando email',
        error: error.message,
      };
    }
  }

  @Post('custom')
  async sendCustomEmail(
    @Body()
    body: {
      to: string | string[];
      subject: string;
      html: string;
      fromName?: string;
      fromEmail?: string;
      cc?: string | string[];
      bcc?: string | string[];
    },
  ) {
    try {
      const result = await this.emailService.sendUniversalEmail(body);
      return {
        success: true,
        message: 'Email enviado correctamente',
        result,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Error enviando email',
        error: error.message,
      };
    }
  }

  @Post('layout')
  async sendLayoutEmail(
    email?: string,
    Subject?: string,
    html?: string,
    organizationUserId?: string,
    opts?: { organizationId?: string; heroUrl?: string; logosUrl?: string },
  ) {
    email = 'Sebastian.cardona.rios2000@gmail.com'
    Subject = "¡Tu suscripción fue actualizada!"
    html = renderSubscriptionContent({ dateUntil: new Date(), variant: 'updated', thanksText: '¡Gracias por confiar en EndoCampus!' });
    organizationUserId = '68c8db2f7fb2b80e98a1bb48'
    try {
      const result = await this.emailService.sendLayoutEmail(email, Subject, html, organizationUserId);
      return {
        email,
        Subject,
        html,
        success: true,
        message: 'Email enviado correctamente',
        result,

      };
    } catch (error) {
      return {
        success: false,
        message: 'Error enviando email',
        error: error.message,
      };
    }
  }

}
