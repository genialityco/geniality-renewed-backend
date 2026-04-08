import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  BadRequestException,
  Request,
} from '@nestjs/common';
import { UserActivityService } from './user-activity.service';

@Controller('user-activity')
export class UserActivityController {
  constructor(private readonly userActivityService: UserActivityService) {}

  /**
   * POST /user-activity/session-start
   * Inicia una nueva sesión de usuario
   */
  @Post('session-start')
  async startSession(
    @Request() req: any,
    @Body() body: { user_id: string; firebase_uid: string; organization_id: string },
  ) {
    const { user_id, firebase_uid, organization_id } = body;

    if (!user_id || !firebase_uid || !organization_id) {
      throw new BadRequestException(
        'user_id, firebase_uid y organization_id son requeridos',
      );
    }

    return this.userActivityService.startSession(user_id, firebase_uid, organization_id);
  }

  /**
   * POST /user-activity/session-end
   * Finaliza la sesión del usuario
   */
  @Post('session-end')
  async endSession(@Body() body: { user_id: string; organization_id: string }) {
    const { user_id, organization_id } = body;

    if (!user_id || !organization_id) {
      throw new BadRequestException('user_id y organization_id son requeridos');
    }

    return this.userActivityService.endSession(user_id, organization_id);
  }

  /**
   * POST /user-activity/update-course-time
   * Actualiza el tiempo dedicado a un curso
   */
  @Post('update-course-time')
  async updateCourseTime(
    @Body()
    body: {
      user_id: string;
      organization_id: string;
      course_id: string;
      event_id: string;
      time_delta_ms: number;
      course_name?: string;
    },
  ) {
    const { user_id, organization_id, course_id, event_id, time_delta_ms, course_name } = body;

    if (!user_id || !organization_id || !course_id || !event_id || time_delta_ms === undefined) {
      throw new BadRequestException(
        'user_id, organization_id, course_id, event_id y time_delta_ms son requeridos',
      );
    }

    if (time_delta_ms < 0) {
      throw new BadRequestException('time_delta_ms no puede ser negativo');
    }

    return this.userActivityService.updateCourseTime(
      user_id,
      organization_id,
      course_id,
      event_id,
      time_delta_ms,
      course_name,
    );
  }

  /**
   * POST /user-activity/update-activity-time
   * Actualiza el tiempo dedicado a una actividad
   */
  @Post('update-activity-time')
  async updateActivityTime(
    @Body()
    body: {
      user_id: string;
      organization_id: string;
      activity_id: string;
      event_id: string;
      time_delta_ms: number;
      activity_name?: string;
    },
  ) {
    const { user_id, organization_id, activity_id, event_id, time_delta_ms, activity_name } = body;

    if (!user_id || !organization_id || !activity_id || !event_id || time_delta_ms === undefined) {
      throw new BadRequestException(
        'user_id, organization_id, activity_id, event_id y time_delta_ms son requeridos',
      );
    }

    if (time_delta_ms < 0) {
      throw new BadRequestException('time_delta_ms no puede ser negativo');
    }

    return this.userActivityService.updateActivityTime(
      user_id,
      organization_id,
      activity_id,
      event_id,
      time_delta_ms,
      activity_name,
    );
  }

  /**
   * GET /user-activity/active/:userId/:organizationId
   * Obtiene el registro de actividad activa del usuario
   */
  @Get('active/:userId/:organizationId')
  async getActiveActivity(
    @Param('userId') userId: string,
    @Param('organizationId') organizationId: string,
  ) {
    if (!userId || !organizationId) {
      throw new BadRequestException('userId y organizationId son requeridos');
    }

    return this.userActivityService.getActiveActivity(userId, organizationId);
  }

  /**
   * GET /user-activity/last/:userId/:organizationId
   * Obtiene el último registro de actividad del usuario
   */
  @Get('last/:userId/:organizationId')
  async getLastActivity(
    @Param('userId') userId: string,
    @Param('organizationId') organizationId: string,
  ) {
    if (!userId || !organizationId) {
      throw new BadRequestException('userId y organizationId son requeridos');
    }

    return this.userActivityService.getLastActivity(userId, organizationId);
  }

  /**
   * GET /user-activity/history/:userId/:organizationId
   * Obtiene el histórico de actividad del usuario
   */
  @Get('history/:userId/:organizationId')
  async getActivityHistory(
    @Param('userId') userId: string,
    @Param('organizationId') organizationId: string,
  ) {
    if (!userId || !organizationId) {
      throw new BadRequestException('userId y organizationId son requeridos');
    }

    return this.userActivityService.getUserActivityHistory(userId, organizationId);
  }
}
