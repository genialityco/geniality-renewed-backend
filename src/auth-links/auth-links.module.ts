import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from 'src/users/schemas/user.schema';
import { UsersModule } from 'src/users/users.module';
import {
  OrganizationUser,
  OrganizationUserSchema,
} from 'src/organization-users/schemas/organization-user.schema';
import {
  Organization,
  OrganizationSchema,
} from 'src/organizations/schemas/organization.schema';
import { AuthLink, AuthLinkSchema } from './auth-link.schema';
import { AuthLinksService } from './auth-links.service';
import { AuthLinksController } from './auth-links.controller';

/** Enlaces de acceso directo para los mensajes de WhatsApp (Gen.ON, retos). */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AuthLink.name, schema: AuthLinkSchema },
      { name: User.name, schema: UserSchema },
      { name: OrganizationUser.name, schema: OrganizationUserSchema },
      { name: Organization.name, schema: OrganizationSchema },
    ]),
    UsersModule,
  ],
  controllers: [AuthLinksController],
  providers: [AuthLinksService],
  exports: [AuthLinksService],
})
export class AuthLinksModule {}
