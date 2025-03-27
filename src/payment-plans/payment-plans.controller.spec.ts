import { Test, TestingModule } from '@nestjs/testing';
import { PaymentPlansController } from './payment-plans.controller';

describe('PaymentPlansController', () => {
  let controller: PaymentPlansController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentPlansController],
    }).compile();

    controller = module.get<PaymentPlansController>(PaymentPlansController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
