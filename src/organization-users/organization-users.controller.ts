import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { OrganizationUsersService } from './organization-users.service';
import { OrganizationUser } from './schemas/organization-user.schema';

@Controller('organization-users')
export class OrganizationUsersController {
  constructor(
    private readonly organizationUsersService: OrganizationUsersService,
  ) {}

  @Post()
  async createOrUpdateUser(
    @Body()
    body: {
      properties: any;
      rol_id: string;
      organization_id: string;
      user_id: string;
      position_id: string;
      payment_plan_id?: string;
    },
  ): Promise<OrganizationUser> {
    const { properties, rol_id, organization_id, user_id, payment_plan_id } =
      body;
    return this.organizationUsersService.createOrUpdateUser(
      properties,
      rol_id,
      organization_id,
      user_id,
      payment_plan_id,
    );
  }

  @Get(':user_id')
  async getUserByUserId(
    @Param('user_id') user_id: string,
  ): Promise<OrganizationUser> {
    return this.organizationUsersService.findByUserId(user_id);
  }
}
