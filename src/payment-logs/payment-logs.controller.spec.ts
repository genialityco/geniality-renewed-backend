import { Test, TestingModule } from '@nestjs/testing';
import { PaymentLogsController } from './payment-logs.controller';

describe('PaymentLogsController', () => {
  let controller: PaymentLogsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentLogsController],
    }).compile();

    controller = module.get<PaymentLogsController>(PaymentLogsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
