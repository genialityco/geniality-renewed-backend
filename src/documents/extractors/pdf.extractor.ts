import { Injectable, Logger } from '@nestjs/common';
import { IContentExtractor, TextCleaner } from './content-extractor.interface';

@Injectable()
export class PdfExtractor implements IContentExtractor {
  private readonly logger = new Logger(PdfExtractor.name);

  async extract(buffer: Buffer): Promise<string> {
    try {
      const pdfParse = require('pdf-parse');
      const pdfData = await pdfParse(buffer);
      const text = pdfData.text || '';
      
      return TextCleaner.clean(text);
    } catch (error) {
      this.logger.error(`Error extracting PDF content: ${error.message}`);
      throw new Error(`Failed to extract PDF content: ${error.message}`);
    }
  }

  canHandle(mimetype: string): boolean {
    return mimetype === 'application/pdf';
  }
}
