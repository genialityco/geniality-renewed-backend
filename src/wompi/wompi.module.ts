import { Module } from '@nestjs/common';
import { WompiService } from './wompi.service';
//import { WompiReconcile } from './wompi.reconcile';
import { PaymentRequestsModule } from '../payment-requests/payment-requests.module';
import { WompiController } from './wompi.controller';
import { PaymentLogsService } from 'src/payment-logs/payment-logs.service';
import { WompiApprovedCron } from './wompi.approved.cron';
import { User, UserSchema } from 'src/users/schemas/user.schema';
import { PaymentPlan, PaymentPlanSchema } from 'src/payment-plans/schemas/payment-plan.schema';
import { UsersModule } from 'src/users/users.module';
import { OrganizationUsersModule } from 'src/organization-users/organization-users.module';
import { PaymentPlansModule } from 'src/payment-plans/payment-plans.module';
import { MongooseModule } from '@nestjs/mongoose';
import {
  PaymentLog,
  PaymentLogSchema,
} from 'src/payment-logs/schemas/payment-log.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PaymentLog.name, schema: PaymentLogSchema },
    ]),
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: PaymentPlan.name, schema: PaymentPlanSchema },
    ]),
    PaymentRequestsModule,
    UsersModule,
    OrganizationUsersModule,
    PaymentPlansModule,
  ],
  controllers: [WompiController],
  providers: [WompiService, /*WompiReconcile,*/ WompiApprovedCron, PaymentLogsService],
  exports: [WompiService],
})
export class WompiModule {}
