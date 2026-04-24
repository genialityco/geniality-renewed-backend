import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
import { Document, DocumentSchema } from './schemas/document.schema';
import { PdfExtractor } from './extractors/pdf.extractor';
import { DocxExtractor } from './extractors/docx.extractor';
import { PptExtractor } from './extractors/ppt.extractor';
import { ExtractorFactory } from './extractors/extractor.factory';
import { UsersModule } from 'src/users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Document.name, schema: DocumentSchema },
    ]),
    UsersModule,
  ],
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    PdfExtractor,
    DocxExtractor,
    PptExtractor,
    ExtractorFactory,
  ],
  exports: [DocumentsService, ExtractorFactory],
})
export class DocumentsModule {}
