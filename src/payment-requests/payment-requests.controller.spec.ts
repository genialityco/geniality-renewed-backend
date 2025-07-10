import { Test, TestingModule } from '@nestjs/testing';
import { PaymentRequestsController } from './payment-requests.controller';

describe('PaymentRequestsController', () => {
  let controller: PaymentRequestsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentRequestsController],
    }).compile();

    controller = module.get<PaymentRequestsController>(PaymentRequestsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
