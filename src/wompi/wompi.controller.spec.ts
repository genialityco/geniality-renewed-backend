import { Test, TestingModule } from '@nestjs/testing';
import { WompiController } from './wompi.controller';

describe('WompiController', () => {
  let controller: WompiController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WompiController],
    }).compile();

    controller = module.get<WompiController>(WompiController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
