import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SessionTokenGuard } from 'src/auth/session-token.guard';
import { OrgAdminGuard } from 'src/auth/org-admin.guard';
import { Organization } from 'src/organizations/schemas/organization.schema';
import { DEFAULT_DAILY_LIMIT } from './assistant.service';

/** Configuración del asistente por organización (solo administradores). */
@UseGuards(SessionTokenGuard, OrgAdminGuard)
@Controller('assistant/organization/:organizationId')
export class AssistantController {
  constructor(
    @InjectModel(Organization.name)
    private readonly organizationModel: Model<Organization>,
  ) {}

  @Get('config')
  async config(@Param('organizationId') organizationId: string) {
    const org: any = await this.organizationModel.collection.findOne(
      { _id: new Types.ObjectId(organizationId) },
      { projection: { assistant: 1 } },
    );
    return {
      enabled: Boolean(org?.assistant?.enabled),
      instructions: org?.assistant?.instructions || '',
      daily_limit: Number(org?.assistant?.daily_limit) || DEFAULT_DAILY_LIMIT,
      // Activo salvo que se apague: los enlaces de las respuestas entran con la sesión iniciada
      auto_login_links: org?.assistant?.auto_login_links !== false,
    };
  }

  @Put('config')
  async update(
    @Param('organizationId') organizationId: string,
    @Body()
    body: {
      enabled?: boolean;
      instructions?: string;
      daily_limit?: number;
      auto_login_links?: boolean;
    },
  ) {
    const limit = Math.round(Number(body?.daily_limit));
    const assistant = {
      enabled: body?.enabled === true,
      instructions: String(body?.instructions || '').slice(0, 2000),
      daily_limit: limit >= 1 && limit <= 500 ? limit : DEFAULT_DAILY_LIMIT,
      auto_login_links: body?.auto_login_links !== false,
    };
    await this.organizationModel.collection.updateOne(
      { _id: new Types.ObjectId(organizationId) },
      { $set: { assistant } },
    );
    return assistant;
  }
}
