import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';

const RESOLUTION_PREFERENCE = ['240p', '360p', '480p', '720p'];

@Injectable()
export class BunnyResolverService {
  private readonly logger = new Logger(BunnyResolverService.name);

  constructor(private readonly httpService: HttpService) {}

  private getPullZoneHostname(libraryId: string): string {
    const raw = process.env.BUNNY_PULL_ZONE_HOSTNAMES || '{}';
    let map: Record<string, string>;
    try {
      map = JSON.parse(raw);
    } catch {
      throw new BadRequestException(
        'BUNNY_PULL_ZONE_HOSTNAMES no es un JSON válido',
      );
    }
    const hostname = map[libraryId];
    if (!hostname) {
      throw new BadRequestException(
        `No hay un pull zone hostname configurado para la librería de Bunny "${libraryId}". Agrégalo a BUNNY_PULL_ZONE_HOSTNAMES.`,
      );
    }
    return hostname;
  }

  /**
   * Resuelve un video de Bunny Stream a una URL MP4 directa y públicamente
   * accesible, para poder pasarla como audio_url a un servicio de
   * transcripción externo.
   */
  async resolveUrl(
    videoId: string,
    libraryId: string | undefined,
  ): Promise<string> {
    if (!libraryId) {
      throw new BadRequestException(
        'El video de Bunny no tiene library_id configurado en meta',
      );
    }

    const apiKey = process.env.BUNNY_STREAM_API_KEY;
    if (!apiKey) {
      throw new BadRequestException(
        'BUNNY_STREAM_API_KEY no está configurada en el entorno',
      );
    }

    const infoUrl = `https://video.bunnycdn.com/library/${libraryId}/videos/${videoId}`;

    let data: any;
    try {
      const response$ = this.httpService.get(infoUrl, {
        headers: { AccessKey: apiKey },
      });
      const response = await lastValueFrom(response$);
      data = response.data;
    } catch (error: any) {
      this.logger.error(
        `Error consultando video de Bunny ${videoId}: ${error.response?.status} ${error.message}`,
      );
      throw new BadRequestException(
        `No se pudo consultar el video de Bunny: ${error.response?.data?.message || error.message}`,
      );
    }

    if (!data?.hasMP4Fallback) {
      throw new BadRequestException(
        `El video de Bunny "${videoId}" todavía no tiene un MP4 disponible (encoding en progreso o fallback deshabilitado)`,
      );
    }

    const available: string[] = (data.availableResolutions || '')
      .split(',')
      .map((r: string) => r.trim())
      .filter(Boolean);
    const resolution =
      RESOLUTION_PREFERENCE.find((r) => available.includes(r)) ||
      available[0] ||
      '360p';

    const hostname = this.getPullZoneHostname(libraryId);
    const url = `https://${hostname}/${videoId}/play_${resolution}.mp4`;
    this.logger.log(`✅ URL de Bunny resuelta (${resolution}): ${url}`);
    return url;
  }
}
