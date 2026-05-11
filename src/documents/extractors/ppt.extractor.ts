import { Injectable, Logger } from '@nestjs/common';
import { IContentExtractor, TextCleaner } from './content-extractor.interface';
const JSZip = require('jszip');

@Injectable()
export class PptExtractor implements IContentExtractor {
  private readonly logger = new Logger(PptExtractor.name);

  async extract(buffer: Buffer): Promise<string> {
    try {
      // PowerPoint files are ZIP archives
      // Extract text from XML content
      const zip = new JSZip();
      const zipData = await zip.loadAsync(buffer);
      
      const textContent: string[] = [];
      
      // Iterate through slides
      const slideRels = zipData.file(/^ppt\/slides\/slide\d+\.xml$/);
      
      for (const file of slideRels) {
        const content = await file.async('string');
        // Simple XML text extraction - get content between tags
        const matches = content.match(/<a:t>([^<]+)<\/a:t>/g) || [];
        const slideText = matches
          .map((match) => match.replace(/<a:t>|<\/a:t>/g, ''))
          .join(' ');
        
        if (slideText.trim()) {
          textContent.push(slideText);
        }
      }
      
      return TextCleaner.clean(textContent.join('\n\n'));
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Error extracting PPT content: ${errorMessage}`);
      throw new Error(`Failed to extract PPT content: ${errorMessage}`);
    }
  }

  canHandle(mimetype: string): boolean {
    return (
      mimetype === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      mimetype === 'application/vnd.ms-powerpoint'
    );
  }
}
