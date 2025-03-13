import { Test, TestingModule } from '@nestjs/testing';
import { ActivityAttendeeService } from './activity-attendee.service';

describe('ActivityAttendeeService', () => {
  let service: ActivityAttendeeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ActivityAttendeeService],
    }).compile();

    service = module.get<ActivityAttendeeService>(ActivityAttendeeService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
