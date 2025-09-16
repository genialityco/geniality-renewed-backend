import { Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { EmailController } from './email.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { Organization, OrganizationSchema } from 'src/organizations/schemas/organization.schema';
import { OrganizationUser, OrganizationUserSchema } from 'src/organization-users/schemas/organization-user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Organization.name, schema: OrganizationSchema, },
      { name: OrganizationUser.name, schema: OrganizationUserSchema, },
    ])
  ],
  providers: [EmailService],
  controllers: [EmailController],
  exports: [EmailService],
})
export class EmailModule { }
