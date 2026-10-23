import { BadRequestException, Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AuthLinksService } from './auth-links.service';

@Controller('auth-links')
export class AuthLinksController {
  constructor(private readonly authLinks: AuthLinksService) {}

  /** POST /auth-links/redeem  { token }  (público: lo llama el navegador al abrir el enlace) */
  @Post('redeem')
  @HttpCode(200)
  async redeem(@Body('token') token?: string) {
    if (typeof token !== 'string' || !token || token.length > 128) {
      throw new BadRequestException('Falta el token');
    }
    return this.authLinks.redeem(token);
  }
}
