import { Test, TestingModule } from '@nestjs/testing';
import { PaymentPlansService } from './payment-plans.service';

describe('PaymentPlansService', () => {
  let service: PaymentPlansService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PaymentPlansService],
    }).compile();

    service = module.get<PaymentPlansService>(PaymentPlansService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
