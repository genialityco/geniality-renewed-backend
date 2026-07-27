import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';

export interface ParsedTranscriptSegment {
  startTime: number;
  endTime: number;
  text: string;
}

export interface VimeoTranscriptResult {
  segments: ParsedTranscriptSegment[];
  fullText: string;
  language: string | null;
  label: string | null;
}

@Injectable()
export class VimeoTranscriptService {
  private readonly logger = new Logger(VimeoTranscriptService.name);

  constructor(private readonly httpService: HttpService) {}

  /**
   * Extrae el ID de video de una URL de Vimeo.
   * Soporta:
   * - https://vimeo.com/123456789
   * - https://vimeo.com/123456789?share=copy
   * - https://player.vimeo.com/video/123456789
   * - https://vimeo.com/video/123456789
   */
  extractVimeoId(url: string): string | null {
    if (!url) return null;
    const cleanUrl = url.split('?')[0];
    const patterns = [
      /player\.vimeo\.com\/video\/(\d+)/,
      /vimeo\.com\/(?:video\/)?(\d+)/,
    ];
    for (const pattern of patterns) {
      const match = cleanUrl.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  isVimeoUrl(url: string): boolean {
    return !!url && url.includes('vimeo');
  }

  /**
   * Descarga la transcripción (text track) que Vimeo ya tiene para el video,
   * usando la API oficial de Vimeo (requiere VIMEO_ACCESS_TOKEN).
   *
   * Devuelve null si el video no tiene ninguna transcripción disponible.
   */
  async fetchTranscript(videoUrl: string): Promise<VimeoTranscriptResult | null> {
    const token = process.env.VIMEO_ACCESS_TOKEN;
    if (!token) {
      throw new Error(
        'VIMEO_ACCESS_TOKEN no está configurado en el entorno del backend.',
      );
    }

    const videoId = this.extractVimeoId(videoUrl);
    if (!videoId) {
      throw new Error(`No se pudo extraer el ID de Vimeo de: ${videoUrl}`);
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.vimeo.*+json;version=3.4',
    };

    // 1. Listar los text tracks del video
    const tracksUrl = `https://api.vimeo.com/videos/${videoId}/texttracks`;
    this.logger.log(`🔍 Consultando text tracks: ${tracksUrl}`);

    const tracksResponse = await lastValueFrom(
      this.httpService.get(tracksUrl, { headers }),
    );

    const tracks: any[] = tracksResponse.data?.data ?? [];
    if (!tracks.length) {
      this.logger.warn(`Video ${videoId} no tiene text tracks en Vimeo.`);
      return null;
    }

    // 2. Elegir el mejor track: preferir español, luego activo, luego el primero
    const track = this.pickBestTrack(tracks);
    if (!track?.link) {
      this.logger.warn(
        `Video ${videoId} tiene text tracks pero sin link descargable.`,
      );
      return null;
    }

    this.logger.log(
      `✅ Track elegido: lang=${track.language} label=${track.name} active=${track.active}`,
    );

    // 3. Descargar el contenido .vtt
    const vttResponse = await lastValueFrom(
      this.httpService.get<string>(track.link, {
        responseType: 'text',
      }),
    );

    const vttContent =
      typeof vttResponse.data === 'string'
        ? vttResponse.data
        : String(vttResponse.data);

    const segments = this.parseVtt(vttContent);
    if (!segments.length) {
      this.logger.warn(`El .vtt de ${videoId} no produjo segmentos.`);
      return null;
    }

    const fullText = segments.map((s) => s.text).join(' ').trim();

    return {
      segments,
      fullText,
      language: track.language ?? null,
      label: track.name ?? null,
    };
  }

  private pickBestTrack(tracks: any[]): any {
    const spanish = tracks.find(
      (t) => typeof t.language === 'string' && t.language.startsWith('es'),
    );
    if (spanish) return spanish;
    const active = tracks.find((t) => t.active);
    if (active) return active;
    return tracks[0];
  }

  /**
   * Convierte un timestamp WebVTT (HH:MM:SS.mmm o MM:SS.mmm) a segundos.
   */
  private timestampToSeconds(ts: string): number {
    const clean = ts.trim().replace(',', '.');
    const parts = clean.split(':').map((p) => parseFloat(p));
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return parseFloat(clean) || 0;
  }

  /**
   * Parsea un archivo WebVTT en segmentos { startTime, endTime, text }.
   */
  parseVtt(vtt: string): ParsedTranscriptSegment[] {
    const segments: ParsedTranscriptSegment[] = [];
    // Normalizar saltos de línea y separar por bloques (líneas en blanco)
    const blocks = vtt
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split(/\n\n+/);

    const timeLineRegex =
      /(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})/;

    for (const block of blocks) {
      const lines = block.split('\n').filter((l) => l.trim() !== '');
      if (!lines.length) continue;

      const timeLineIndex = lines.findIndex((l) => timeLineRegex.test(l));
      if (timeLineIndex === -1) continue; // encabezado WEBVTT, NOTE, etc.

      const match = lines[timeLineIndex].match(timeLineRegex);
      if (!match) continue;

      const startTime = this.timestampToSeconds(match[1]);
      const endTime = this.timestampToSeconds(match[2]);

      const textLines = lines.slice(timeLineIndex + 1);
      const text = textLines
        .join(' ')
        // Quitar tags de estilo/karaoke tipo <c>, <00:00:00.000>, <v Autor>
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (text) {
        segments.push({ startTime, endTime, text });
      }
    }

    return segments;
  }
}
