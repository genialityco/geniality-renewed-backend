import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';

@Injectable()
export class VimeoResolverService {
  private readonly logger = new Logger(VimeoResolverService.name);

  constructor(private readonly httpService: HttpService) {}

  /**
   * Extrae el ID de video de una URL de Vimeo
   * Soporta formatos:
   * - https://vimeo.com/123456789
   * - https://vimeo.com/123456789?share=copy
   * - https://player.vimeo.com/video/123456789
   * - https://vimeo.com/video/123456789
   */
  private extractVimeoId(url: string): string | null {
    // Primero remover query params
    const cleanUrl = url.split('?')[0];
    
    const patterns = [
      /vimeo\.com\/(?:video\/)?(\d+)/,
      /player\.vimeo\.com\/video\/(\d+)/,
    ];

    for (const pattern of patterns) {
      const match = cleanUrl.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Obtiene la URL de streaming directo de Vimeo
   * Usando el endpoint de configuración del player que devuelve las URLs disponibles
   */
  async resolveVimeoUrl(vimeoUrl: string): Promise<string> {
    try {
      const videoId = this.extractVimeoId(vimeoUrl);
      if (!videoId) {
        this.logger.warn(
          `Could not extract video ID from ${vimeoUrl}, using original URL`,
        );
        return vimeoUrl;
      }

      this.logger.log(`🔍 Resolving Vimeo video ID: ${videoId}`);
      this.logger.log(`Original URL format: ${vimeoUrl}`);

      // Método 1: Intentar obtener el embed JSON que tiene mejor acceso público
      try {
        const embedUrl = `https://vimeo.com/api/oembed.json?url=https://vimeo.com/${videoId}`;
        this.logger.log(`Trying embed endpoint: ${embedUrl}`);
        
        const embedResponse$ = this.httpService.get(embedUrl);
        const embedResponse = await lastValueFrom(embedResponse$);
        this.logger.log(`✅ Got embed metadata: ${JSON.stringify(embedResponse.data).substring(0, 200)}`);
      } catch (embedError: any) {
        this.logger.warn(`Embed endpoint failed: ${embedError.message}`);
      }

      // Método 2: Endpoint de config del player
      const configUrl = `https://player.vimeo.com/video/${videoId}/config`;
      this.logger.log(`Trying config endpoint: ${configUrl}`);

      try {
        const response$ = this.httpService.get(configUrl);
        const response = await lastValueFrom(response$);
        const config = response.data;

        this.logger.log(`Config response keys: ${Object.keys(config).join(', ')}`);

        // Buscar la URL de streaming en las respuestas disponibles
        if (config.request?.files?.progressive) {
          const files = config.request.files.progressive;
          this.logger.log(`Found progressive files: ${files.length}`);
          
          // Obtener la calidad más alta disponible
          const highestQuality = files.reduce((prev: any, current: any) =>
            prev.height > current.height ? prev : current,
          );

          if (highestQuality?.url) {
            this.logger.log(
              `✅ Resolved Vimeo URL to direct stream (${highestQuality.height}p)`,
            );
            return highestQuality.url;
          }
        }

        // Si no hay progressive files, intentar con otros formatos
        if (config.request?.files?.hls?.url) {
          this.logger.log(`✅ Resolved Vimeo URL to HLS stream`);
          return config.request.files.hls.url;
        }

        // Log detallado para debugging
        this.logger.warn(
          `No progressive/HLS files found. Config structure: ${JSON.stringify(config).substring(0, 300)}`,
        );

        this.logger.warn(
          `Could not resolve streaming URL from Vimeo config, maintaining original URL format`,
        );
        // Mantener el formato original si viene de player.vimeo.com
        if (vimeoUrl.includes('player.vimeo.com')) {
          this.logger.log(`Keeping player.vimeo.com format`);
          return vimeoUrl;
        }
        // Para otras URLs, retornar formato estándar de Vimeo
        return `https://vimeo.com/${videoId}`;
      } catch (error: any) {
        this.logger.error(
          `Error fetching Vimeo config: [${error.response?.status}] ${error.message}`,
        );
        this.logger.warn(`Maintaining original URL format as fallback`);
        // Mantener el formato original en caso de error
        return vimeoUrl;
      }
    } catch (error: any) {
      this.logger.error(`Error in resolveVimeoUrl: ${error.message}`);
      return vimeoUrl;
    }
  }

  /**
   * Resolve URL a su forma más descargable
   * Si es Vimeo, obtiene URL directo. Si no, retorna el mismo URL.
   */
  async resolveUrl(videoUrl: string): Promise<string> {
    if (videoUrl.includes('vimeo')) {
      return this.resolveVimeoUrl(videoUrl);
    }

    // Para otros tipos de URLs (YouTube, etc) dejar que yt-dlp lo maneje
    return videoUrl;
  }
}
