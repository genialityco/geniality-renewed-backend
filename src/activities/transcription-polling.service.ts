import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { TranscriptSegmentsService } from 'src/transcript-segments/transcript-segments.service';
import { ActivitiesService } from './activities.service';
import { lastValueFrom } from 'rxjs';

@Injectable()
export class TranscriptionPollingService {
  private readonly logger = new Logger(TranscriptionPollingService.name);
  private pollingIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private readonly httpService: HttpService,
    private readonly transcriptSegmentsService: TranscriptSegmentsService,
    private readonly activitiesService: ActivitiesService,
  ) {}

  /**
   * Inicia un polling asincrónico para obtener los resultados de una transcripción.
   * No bloquea la respuesta del API.
   *
   * @param jobId - ID del job de transcripción
   * @param activityId - ID de la actividad
   */
  startPolling(jobId: string, activityId: string): void {
    // Si ya hay un polling activo para este job, no iniciar otro
    if (this.pollingIntervals.has(jobId)) {
      this.logger.warn(`Polling already active for job ${jobId}`);
      return;
    }

    this.logger.log(
      `🔄 Starting polling for job ${jobId} (activity: ${activityId})`,
    );

    // Iniciar polling cada 5 segundos
    const intervalId = setInterval(async () => {
      try {
        await this.checkTranscriptionStatus(jobId, activityId);
      } catch (error: any) {
        this.logger.error(
          `Error during polling for job ${jobId}: ${error.message}`,
        );
      }
    }, 5000); // 5 segundos

    // Guardar el interval para poder detenerlo después
    this.pollingIntervals.set(jobId, intervalId);

    // Timeout: detener polling después de 60 minutos (máximo razonableintentaré 60 minutos para videos largos)
    setTimeout(() => {
      if (this.pollingIntervals.has(jobId)) {
        this.logger.warn(`Polling timeout for job ${jobId} after 60 minutes`);
        this.stopPolling(jobId);
      }
    }, 60 * 60 * 1000);
  }

  /**
   * Verifica el estado de la transcripción.
   */
  private async checkTranscriptionStatus(
    jobId: string,
    activityId: string,
  ): Promise<void> {
    try {
      const baseUrl =
        process.env.TRANSCRIPTION_SERVICE_URL || 'http://127.0.0.1:5001';
      const resultUrl = `${baseUrl}/transcribe/${jobId}/result`;
      this.logger.debug(`🔍 Polling: GET ${resultUrl}`);
      
      const response$ = this.httpService.get(resultUrl);
      const response = await lastValueFrom(response$);
      const data = response.data;

      this.logger.debug(`📥 Response status: ${data.status}`);

      if (data.status === 'done' && data.segments) {
        this.logger.log(
          `✅ Transcription completed for job ${jobId} with ${data.segments.length} segments`,
        );

        // Guardar segmentos en MongoDB
        await this.transcriptSegmentsService.createSegments(
          activityId,
          data.segments,
        );

        // Marcar transcripción como disponible
        await this.activitiesService.updateTranscriptAvailable(activityId, true);
        this.logger.log(
          `✏️ Activity ${activityId} marked as transcript_available: true`,
        );

        // Detener polling
        this.stopPolling(jobId);
      } else if (data.status === 'error') {
        this.logger.error(
          `❌ Transcription error for job ${jobId}: ${data.error}`,
        );
        this.stopPolling(jobId);
      } else if (data.status === 'processing') {
        this.logger.debug(`⏳ Job ${jobId} still processing...`);
      }
    } catch (error: any) {
      // Capturar la respuesta del error para ver qué dice exactamente
      const errorResponse = error.response?.data;
      const statusCode = error.response?.status;
      const errorMessage = errorResponse?.error || error.message;

      this.logger.error(
        `Error checking transcription status for job ${jobId}: [${statusCode}] ${errorMessage}`,
      );

      // Log detallado para debugging
      if (errorResponse) {
        this.logger.error(
          `Full error response: ${JSON.stringify(errorResponse)}`,
        );
      }

      // No detener el polling en caso de error - reintentar en el próximo intervalo
    }
  }

  /**
   * Detiene el polling para un job específico.
   */
  private stopPolling(jobId: string): void {
    const intervalId = this.pollingIntervals.get(jobId);
    if (intervalId) {
      clearInterval(intervalId);
      this.pollingIntervals.delete(jobId);
      this.logger.log(`⏹️ Polling stopped for job ${jobId}`);
    }
  }

  /**
   * Detiene todos los pollings activos (útil para shutdown graceful).
   */
  stopAllPolling(): void {
    this.pollingIntervals.forEach((intervalId) => {
      clearInterval(intervalId);
    });
    this.pollingIntervals.clear();
    this.logger.log('⏹️ All polling intervals stopped');
  }
}
