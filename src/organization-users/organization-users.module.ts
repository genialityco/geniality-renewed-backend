import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  OrganizationUser,
  OrganizationUserSchema,
} from './schemas/organization-user.schema';
import { OrganizationUsersService } from './organization-users.service';
import { OrganizationUsersController } from './organization-users.controller';
import { EmailModule } from 'src/email/email.module'; // ✅ importa el módulo

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OrganizationUser.name, schema: OrganizationUserSchema },
    ]),
    EmailModule,
  ],
  controllers: [OrganizationUsersController],
  providers: [OrganizationUsersService],
  exports: [OrganizationUsersService],
})
export class OrganizationUsersModule {}
