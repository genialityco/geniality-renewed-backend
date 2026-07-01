import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CertificateTemplatesService } from './certificate-templates.service';
import { CertificateTemplatesController } from './certificate-templates.controller';
import {
  CertificateTemplate,
  CertificateTemplateSchema,
} from './schemas/certificate-template.schema';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CertificateTemplate.name, schema: CertificateTemplateSchema },
    ]),
    UsersModule,
  ],
  controllers: [CertificateTemplatesController],
  providers: [CertificateTemplatesService],
  exports: [CertificateTemplatesService],
})
export class CertificateTemplatesModule {}
