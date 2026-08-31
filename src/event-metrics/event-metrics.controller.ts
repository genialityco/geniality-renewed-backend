import {
  BadRequestException,
  Controller,
  Get,
  Param,
  UseGuards,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { SessionTokenGuard } from 'src/auth/session-token.guard';
import { OrgMembershipGuard } from 'src/auth/org-membership.guard';
import {
  EventMetricsService,
  EventMetrics,
  EventMembersMetrics,
} from './event-metrics.service';

@Controller('event-metrics')
export class EventMetricsController {
  constructor(private readonly eventMetricsService: EventMetricsService) {}

  /**
   * GET /event-metrics/organization/:organizationId/event/:eventId
   *
   * Métricas agregadas de un curso/evento para el dashboard de admin:
   * inscripciones, progreso, embudo por actividad, tiempo invertido,
   * resultados de quiz y certificados.
   *
   * :organizationId va en la ruta porque OrgMembershipGuard valida la
   * pertenencia del usuario autenticado a esa organización; el service
   * verifica además que el evento pertenezca a la organización.
   */
  @UseGuards(SessionTokenGuard, OrgMembershipGuard)
  @Get('organization/:organizationId/event/:eventId')
  async getEventMetrics(
    @Param('organizationId') organizationId: string,
    @Param('eventId') eventId: string,
  ): Promise<EventMetrics> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException('eventId inválido');
    }
    return this.eventMetricsService.getEventMetrics(eventId, organizationId);
  }

  /**
   * GET /event-metrics/organization/:organizationId/event/:eventId/members
   *
   * Avance de cada miembro inscrito, actividad por actividad. Complementa el
   * embudo agregado de arriba con el detalle por usuario.
   */
  @UseGuards(SessionTokenGuard, OrgMembershipGuard)
  @Get('organization/:organizationId/event/:eventId/members')
  async getEventMembers(
    @Param('organizationId') organizationId: string,
    @Param('eventId') eventId: string,
  ): Promise<EventMembersMetrics> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException('eventId inválido');
    }
    return this.eventMetricsService.getEventMembers(eventId, organizationId);
  }
}
