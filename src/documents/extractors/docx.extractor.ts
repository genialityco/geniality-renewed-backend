import { Injectable, Logger } from '@nestjs/common';
import { IContentExtractor, TextCleaner } from './content-extractor.interface';

@Injectable()
export class DocxExtractor implements IContentExtractor {
  private readonly logger = new Logger(DocxExtractor.name);

  async extract(buffer: Buffer): Promise<string> {
    try {
      // Lazy import to avoid errors when mammoth is not available
      const mammoth = require('mammoth');
      
      const result = await mammoth.extractRawText({ buffer });
      const text = result.value || '';
      
      return TextCleaner.clean(text);
    } catch (error) {
      this.logger.error(`Error extracting DOCX content: ${error.message}`);
      throw new Error(`Failed to extract DOCX content: ${error.message}`);
    }
  }

  canHandle(mimetype: string): boolean {
    return (
      mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mimetype === 'application/msword'
    );
  }
}
