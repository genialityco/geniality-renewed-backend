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
}
