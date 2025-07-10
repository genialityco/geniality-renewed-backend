import { Test, TestingModule } from '@nestjs/testing';
import { PaymentRequestsService } from './payment-requests.service';

describe('PaymentRequestsService', () => {
  let service: PaymentRequestsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PaymentRequestsService],
    }).compile();

    service = module.get<PaymentRequestsService>(PaymentRequestsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
