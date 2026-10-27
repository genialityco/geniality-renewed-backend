import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SessionTokenGuard } from 'src/auth/session-token.guard';
import { GenOnMyStreakService } from './genon-my-streak.service';

/**
 * Lo que el estudiante ve de Gen.ON en la plataforma: su racha académica
 * (perfil, encabezado y aviso al lograrla). Solo datos de quien inició sesión.
 */
@UseGuards(SessionTokenGuard)
@Controller('genon/me')
export class GenOnMeController {
  constructor(private readonly streaks: GenOnMyStreakService) {}

  @Get('streaks')
  async myStreaks(
    @Req() req: any,
    @Query('organizationId') organizationId?: string,
    @Query('eventId') eventId?: string,
  ) {
    return {
      streaks: await this.streaks.mine(req.auth.uid, {
        organizationId: organizationId || undefined,
        eventId: eventId || undefined,
      }),
    };
  }

  /** El aviso del logro ya se mostró. */
  @Post('streaks/:enrollmentId/seen')
  seen(
    @Req() req: any,
    @Param('enrollmentId') enrollmentId: string,
    @Body() body: { key?: string },
  ) {
    return this.streaks.markSeen(req.auth.uid, enrollmentId, String(body?.key || ''));
  }
}
