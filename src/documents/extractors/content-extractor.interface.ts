export interface IContentExtractor {
  extract(buffer: Buffer): Promise<string>;
  canHandle(mimetype: string): boolean;
}

export class TextCleaner {
  static clean(text: string): string {
    // Eliminar múltiples saltos de línea consecutivos
    let cleaned = text.replace(/\n\n+/g, '\n\n');
    
    // Eliminar espacios en blanco múltiples
    cleaned = cleaned.replace(/[ \t]+/g, ' ');
    
    // Eliminar espacios al inicio y final
    cleaned = cleaned.trim();
    
    return cleaned;
  }
}
