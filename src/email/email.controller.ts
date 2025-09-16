import { Controller, Post, Body } from '@nestjs/common';
import { EmailService } from './email.service';

@Controller('email')
export class EmailController {
  constructor(private readonly emailService: EmailService) {}
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
    html = '<p>Prueba de email con layout</p>'
    organizationUserId = '68c8d585eea29b3c7264ad5d'
    try {
      const result = await this.emailService.sendLayoutEmail(email, Subject, html, organizationUserId);
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

}
