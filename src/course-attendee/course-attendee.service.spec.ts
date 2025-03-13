import { Test, TestingModule } from '@nestjs/testing';
import { CourseAttendeeService } from './course-attendee.service';

describe('CourseAttendeeService', () => {
  let service: CourseAttendeeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CourseAttendeeService],
    }).compile();

    service = module.get<CourseAttendeeService>(CourseAttendeeService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
