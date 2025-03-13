import { Test, TestingModule } from '@nestjs/testing';
import { ActivityAttendeeController } from './activity-attendee.controller';

describe('ActivityAttendeeController', () => {
  let controller: ActivityAttendeeController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ActivityAttendeeController],
    }).compile();

    controller = module.get<ActivityAttendeeController>(ActivityAttendeeController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
