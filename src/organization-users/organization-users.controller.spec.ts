import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationUsersController } from './organization-users.controller';

describe('OrganizationUsersController', () => {
  let controller: OrganizationUsersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationUsersController],
    }).compile();

    controller = module.get<OrganizationUsersController>(OrganizationUsersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
