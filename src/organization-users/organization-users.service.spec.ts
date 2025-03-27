import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationUsersService } from './organization-users.service';

describe('OrganizationUsersService', () => {
  let service: OrganizationUsersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OrganizationUsersService],
    }).compile();

    service = module.get<OrganizationUsersService>(OrganizationUsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
