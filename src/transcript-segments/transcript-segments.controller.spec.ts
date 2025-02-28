import { Test, TestingModule } from '@nestjs/testing';
import { TranscriptSegmentsController } from './transcript-segments.controller';

describe('TranscriptSegmentsController', () => {
  let controller: TranscriptSegmentsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TranscriptSegmentsController],
    }).compile();

    controller = module.get<TranscriptSegmentsController>(
      TranscriptSegmentsController,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
