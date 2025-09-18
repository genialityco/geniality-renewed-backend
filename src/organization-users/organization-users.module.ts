import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  OrganizationUser,
  OrganizationUserSchema,
} from './schemas/organization-user.schema';
import { OrganizationUsersService } from './organization-users.service';
import { OrganizationUsersController } from './organization-users.controller';
import { EmailModule } from 'src/email/email.module';
import { UsersModule } from 'src/users/users.module';
import { PaymentPlansModule } from 'src/payment-plans/payment-plans.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OrganizationUser.name, schema: OrganizationUserSchema },
    ]),
    EmailModule,
    UsersModule,
    forwardRef(() => PaymentPlansModule),
  ],
  controllers: [OrganizationUsersController],
  providers: [OrganizationUsersService],
  exports: [OrganizationUsersService],
})
export class OrganizationUsersModule { }
