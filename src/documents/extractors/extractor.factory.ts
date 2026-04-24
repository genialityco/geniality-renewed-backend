import { Injectable, Logger } from '@nestjs/common';
import { IContentExtractor } from './content-extractor.interface';
import { PdfExtractor } from './pdf.extractor';
import { DocxExtractor } from './docx.extractor';
import { PptExtractor } from './ppt.extractor';

@Injectable()
export class ExtractorFactory {
  private readonly logger = new Logger(ExtractorFactory.name);
  private extractors: IContentExtractor[];

  constructor(
    private pdfExtractor: PdfExtractor,
    private docxExtractor: DocxExtractor,
    private pptExtractor: PptExtractor,
  ) {
    this.extractors = [this.pdfExtractor, this.docxExtractor, this.pptExtractor];
  }

  getExtractor(mimetype: string): IContentExtractor {
    const extractor = this.extractors.find((e) => e.canHandle(mimetype));
    
    if (!extractor) {
      throw new Error(`No extractor available for mimetype: ${mimetype}`);
    }
    
    return extractor;
  }

  async extractContent(buffer: Buffer, mimetype: string): Promise<string> {
    try {
      const extractor = this.getExtractor(mimetype);
      return await extractor.extract(buffer);
    } catch (error) {
      this.logger.error(`Error during content extraction: ${error.message}`);
      throw error;
    }
  }

  isSupportedMimetype(mimetype: string): boolean {
    return this.extractors.some((e) => e.canHandle(mimetype));
  }

  getSupportedMimetypes(): string[] {
    return [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-powerpoint',
    ];
  }
}
