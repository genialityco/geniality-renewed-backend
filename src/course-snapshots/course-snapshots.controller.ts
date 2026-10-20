import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { SessionTokenGuard } from 'src/auth/session-token.guard';
import { OrgAdminGuard } from 'src/auth/org-admin.guard';
import { UsersService } from 'src/users/users.service';
import { CourseSnapshotsService } from './course-snapshots.service';
import { CourseUserStatus } from './schemas/course-snapshot-user.schema';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const USER_STATUSES: CourseUserStatus[] = [
  'completed',
  'active',
  'inactive',
  'never_active',
];

/**
 * Líneas base y snapshots diarios de indicadores por curso. Solo para
 * administradores de la organización de la ruta.
 */
@UseGuards(SessionTokenGuard, OrgAdminGuard)
@Controller('course-snapshots/organization/:organizationId')
export class CourseSnapshotsController {
  constructor(
    private readonly snapshotsService: CourseSnapshotsService,
    private readonly usersService: UsersService,
  ) {}

  /** POST /course-snapshots/organization/:organizationId/baselines */
  @Post('baselines')
  async createBaseline(
    @Param('organizationId') organizationId: string,
    @Headers('x-uid') uid: string | undefined,
    @Body('label') label?: string,
    @Body('eventIds') eventIds?: string[],
  ) {
    if (eventIds !== undefined && !Array.isArray(eventIds)) {
      throw new BadRequestException('"eventIds" debe ser un arreglo');
    }
    if (eventIds?.some((id) => !Types.ObjectId.isValid(String(id)))) {
      throw new BadRequestException('"eventIds" contiene ids inválidos');
    }
    const user = uid
      ? await this.usersService.findByFirebaseUid(uid).catch(() => null)
      : null;
    return this.snapshotsService.createBaseline(organizationId, {
      label: typeof label === 'string' ? label.slice(0, 120) : undefined,
      eventIds,
      takenBy: user?._id ? String(user._id) : null,
    });
  }

  @Get('baselines')
  async listBaselines(@Param('organizationId') organizationId: string) {
    return this.snapshotsService.listBaselines(organizationId);
  }

  @Get('baselines/:batchId')
  async getBaseline(
    @Param('organizationId') organizationId: string,
    @Param('batchId') batchId: string,
  ) {
    return this.snapshotsService.getBaseline(organizationId, batchId);
  }

  @Get('baselines/:batchId/events/:eventId/users')
  async getBaselineUsers(
    @Param('organizationId') organizationId: string,
    @Param('batchId') batchId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.snapshotsService.getBaselineUsers(
      organizationId,
      batchId,
      eventId,
    );
  }

  @Delete('baselines/:batchId')
  async deleteBaseline(
    @Param('organizationId') organizationId: string,
    @Param('batchId') batchId: string,
  ) {
    return this.snapshotsService.deleteBaseline(organizationId, batchId);
  }

  /** Ejecuta ya el snapshot diario de los cursos de la organización. */
  @Post('daily/run')
  async runDaily(@Param('organizationId') organizationId: string) {
    return this.snapshotsService.runDaily(organizationId);
  }

  /**
   * GET /course-snapshots/organization/:organizationId/daily/users
   *   ?eventId=&status=inactive,never_active&minDaysInactive=7&reachable=true&limit=
   *
   * Estado de cada estudiante según el último snapshot diario: la lista de
   * seguimiento (p. ej. "activos con 7+ días sin estudiar y alcanzables").
   */
  @Get('daily/users')
  async getUserStates(
    @Param('organizationId') organizationId: string,
    @Query('eventId') eventId?: string,
    @Query('status') status?: string,
    @Query('minDaysInactive') minDaysInactive?: string,
    @Query('reachable') reachable?: string,
    @Query('limit') limit?: string,
  ) {
    const statuses = status
      ? status.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    if (statuses?.some((s) => !USER_STATUSES.includes(s as CourseUserStatus))) {
      throw new BadRequestException(
        `"status" admite: ${USER_STATUSES.join(', ')}`,
      );
    }
    const minDays =
      minDaysInactive !== undefined ? Number(minDaysInactive) : undefined;
    if (minDays !== undefined && !Number.isFinite(minDays)) {
      throw new BadRequestException('"minDaysInactive" debe ser un número');
    }
    return this.snapshotsService.getUserStates(organizationId, {
      eventId: eventId || undefined,
      statuses: statuses as CourseUserStatus[] | undefined,
      minDaysInactive: minDays,
      reachable: reachable === 'true',
      limit: limit ? Number(limit) || undefined : undefined,
    });
  }

  @Get('daily/events/:eventId')
  async getDaily(
    @Param('organizationId') organizationId: string,
    @Param('eventId') eventId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
      throw new BadRequestException(
        '"from"/"to" deben tener formato YYYY-MM-DD',
      );
    }
    return this.snapshotsService.getDaily(organizationId, eventId, from, to);
  }
}
