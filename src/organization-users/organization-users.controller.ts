import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { OrganizationUsersService } from './organization-users.service';
import { OrganizationUser } from './schemas/organization-user.schema';

@Controller('organization-users')
export class OrganizationUsersController {
  constructor(
    private readonly organizationUsersService: OrganizationUsersService,
  ) { }

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

  @Post(':user_id/delete')
  async deleteById(@Param('user_id') user_id: string) {
    await this.organizationUsersService.deleteOrganizationUser(user_id);
    return { message: 'Usuario eliminado' };
  }
  

  @Get(':user_id')
  async getUserByUserId(
    @Param('user_id') user_id: string,
  ): Promise<OrganizationUser> {
    return this.organizationUsersService.findByUserId(user_id);
  }

  @Get('by-organization/:organization_id')
  async getUsersByOrganizationId(
    @Param('organization_id') organization_id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ): Promise<{ results: OrganizationUser[]; total: number }> {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;
    return this.organizationUsersService.findByOrganizationId(
      organization_id,
      pageNum,
      limitNum,
      search,
    );
  }

  @Get('by-email/:email')
  async getUserByEmail(
    @Param('email') email: string,
  ): Promise<OrganizationUser | null> {
    return this.organizationUsersService.findByEmail(email);
  }

  @Get('/recovery-password/:email')
  async recoverPassword(@Param('email') email: string) {
    return this.organizationUsersService.recoverPassword(email);
  }

  @Get('all-by-organization/:organization_id')
  async getAllUsersByOrganizationId(
    @Param('organization_id') organization_id: string,
    @Query('search') search?: string,
  ): Promise<OrganizationUser[]> {
    return this.organizationUsersService.findAllByOrganizationId(
      organization_id,
      search,
    );
  }

  @Get('organizations-by-user/:user_id')
  async getOrganizationsByUser(@Param('user_id') user_id: string) {
    return this.organizationUsersService.findOrganizationsByUserId(user_id);
  }
}
