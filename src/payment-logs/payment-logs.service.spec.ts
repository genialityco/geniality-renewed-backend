import { Test, TestingModule } from '@nestjs/testing';
import { PaymentLogsService } from './payment-logs.service';

describe('PaymentLogsService', () => {
  let service: PaymentLogsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PaymentLogsService],
    }).compile();

    service = module.get<PaymentLogsService>(PaymentLogsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
