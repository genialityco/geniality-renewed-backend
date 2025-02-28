import { Test, TestingModule } from '@nestjs/testing';
import { TranscriptSegmentsService } from './transcript-segments.service';

describe('TranscriptSegmentsService', () => {
  let service: TranscriptSegmentsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TranscriptSegmentsService],
    }).compile();

    service = module.get<TranscriptSegmentsService>(TranscriptSegmentsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
