import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PaymentPlan, PaymentPlanSchema } from './schemas/payment-plan.schema';
import { PaymentPlansService } from './payment-plans.service';
import { PaymentPlansController } from './payment-plans.controller';
import { OrganizationUsersModule } from '../organization-users/organization-users.module';
import { EmailModule } from 'src/email/email.module';
import {
  OrganizationUser,
  OrganizationUserSchema,
} from 'src/organization-users/schemas/organization-user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PaymentPlan.name, schema: PaymentPlanSchema },
      { name: OrganizationUser.name, schema: OrganizationUserSchema },
    ]),
    OrganizationUsersModule,
    EmailModule,
  ],
  controllers: [PaymentPlansController],
  providers: [PaymentPlansService],
  exports: [PaymentPlansService],
})
export class PaymentPlansModule {}
