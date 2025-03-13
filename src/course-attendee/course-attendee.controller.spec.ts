import { Test, TestingModule } from '@nestjs/testing';
import { CourseAttendeeController } from './course-attendee.controller';

describe('CourseAttendeeController', () => {
  let controller: CourseAttendeeController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CourseAttendeeController],
    }).compile();

    controller = module.get<CourseAttendeeController>(CourseAttendeeController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
