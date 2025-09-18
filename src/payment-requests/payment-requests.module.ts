import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  PaymentRequest,
  PaymentRequestSchema,
} from './schemas/payment-request.schema';
import {
  OrganizationUser,
  OrganizationUserSchema,
} from '../organization-users/schemas/organization-user.schema';
import {
  PaymentPlan,
  PaymentPlanSchema,
} from '../payment-plans/schemas/payment-plan.schema';

import { PaymentRequestsService } from './payment-requests.service';
import { PaymentRequestsController } from './payment-requests.controller';
import { PaymentPlansModule } from 'src/payment-plans/payment-plans.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PaymentRequest.name, schema: PaymentRequestSchema },
      { name: OrganizationUser.name, schema: OrganizationUserSchema },
      { name: PaymentPlan.name, schema: PaymentPlanSchema },
    ]),
    PaymentPlansModule,
  ],
  controllers: [PaymentRequestsController],
  providers: [PaymentRequestsService],
  exports: [PaymentRequestsService],
})
export class PaymentRequestsModule {}
// export class PaymentRequestsModule implements NestModule {
//   configure(consumer: MiddlewareConsumer) {
//     consumer.apply(WebhookTapMiddleware).forRoutes({
//       path: 'payment-requests/webhook', // coincide con tu @Controller('payment-requests') + @Post('webhook')
//       method: RequestMethod.POST, // o ALL si quieres interceptar todo
//     });
//   }
// }
