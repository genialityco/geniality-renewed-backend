import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Activity } from 'src/activities/schemas/activity.schema';
import { TranscriptSegmentsService } from 'src/transcript-segments/transcript-segments.service';
import {
  CaseExpectedItem,
  CaseResource,
  CaseStage,
} from './schemas/clinical-case.schema';
import { idVariants } from './course-content.service';
import { GeminiTextClient } from './gemini-text.client';
import { formatTime, normalizeText, similarity } from './practice-format';

/** Dos candidatos son el mismo momento: mismo minuto de la misma actividad, o casi el mismo texto a la misma hora en otra. */
function sameMoment(
  a: { activity_id: string; startTime: number; context: string },
  b: { activity_id: string; startTime: number; context: string },
) {
  if (
    a.activity_id === b.activity_id &&
    Math.floor(a.startTime / 60) === Math.floor(b.startTime / 60)
  ) {
    return true;
  }
  return (
    Math.abs(a.startTime - b.startTime) <= 5 &&
    similarity(
      normalizeText(a.context.slice(0, 200)),
      normalizeText(b.context.slice(0, 200)),
    ) >= 0.6
  );
}

const MAX_RESOURCES_PER_ITEM = 2;
// Candidatos que la IA revisa por paso, y pasos por llamada a la IA
const CANDIDATES_PER_ITEM = 6;
const RERANK_BATCH = 8;
// Búsquedas simultáneas al calcular los recursos de un caso completo
const CONCURRENCY = 4;
// Se arranca el video un poco antes del segmento para dar contexto
const LEAD_SECONDS = 3;

/**
 * "Dónde estudiarlo": para cada paso esperado de un caso clínico busca en los
 * transcripts del curso (texto + semántica) candidatos de actividad y minuto,
 * y la IA verifica cuáles explican de verdad el contenido. Se precalcula al generar el caso (el admin puede
 * quitar recursos) y, si falta, se busca al terminar el intento.
 */
@Injectable()
export class ClinicalCaseResourcesService {
  private readonly logger = new Logger(ClinicalCaseResourcesService.name);

  constructor(
    @InjectModel(Activity.name)
    private readonly activityModel: Model<Activity>,
    private readonly segments: TranscriptSegmentsService,
    private readonly gemini: GeminiTextClient,
  ) {}

  /** Actividades del curso (id → nombre), alcance de la búsqueda. */
  async courseActivities(eventId: unknown) {
    const activities = await this.activityModel
      .find({ event_id: { $in: idVariants(eventId) } })
      .select('name')
      .lean()
      .exec();
    return new Map(
      activities.map((a) => [String(a._id), a.name || 'Actividad']),
    );
  }

  /**
   * Para cada paso: candidatos de la búsqueda (texto + semántica) y la IA
   * elige los que de verdad explican el contenido. Mejor ningún enlace que
   * uno que no tiene que ver. Si la IA falla, queda el mejor candidato.
   */
  private async resolveBatch(
    items: CaseExpectedItem[],
    activities: Map<string, string>,
  ) {
    const candidates = new Map<
      string,
      Awaited<
        ReturnType<TranscriptSegmentsService['searchCandidatesInActivities']>
      >
    >();
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      await Promise.all(
        items.slice(i, i + CONCURRENCY).map(async (item) => {
          try {
            candidates.set(
              item.id,
              await this.segments.searchCandidatesInActivities(
                item.text,
                [...activities.keys()],
                CANDIDATES_PER_ITEM,
              ),
            );
          } catch (error) {
            this.logger.warn(
              `Búsqueda de recursos para "${item.text}": ${(error as Error).message}`,
            );
            candidates.set(item.id, []);
          }
        }),
      );
    }

    const toResource = (c: {
      activity_id: string;
      name_activity?: string;
      startTime: number;
    }) => ({
      activity_id: c.activity_id,
      activity_name:
        activities.get(c.activity_id) || c.name_activity || 'Actividad',
      start_time: Math.max(0, Math.floor(c.startTime) - LEAD_SECONDS),
    });

    const withCandidates = items.filter((i) => candidates.get(i.id)?.length);
    for (const item of items) item.resources = [];
    if (!withCandidates.length) return;

    const blocks = withCandidates.map((item, k) => {
      const list = (candidates.get(item.id) || [])
        .map(
          (c, j) =>
            `  c${k}_${j}: [${activities.get(c.activity_id) || c.name_activity || 'Actividad'}, min ${formatTime(c.startTime)}] "${c.context.replace(/"/g, "'")}"`,
        )
        .join('\n');
      return `PASO i${k}: ${item.text}${item.rationale ? ` (por qué: ${item.rationale})` : ''}\n${list}`;
    });
    try {
      const res = await this.gemini.generateJson<{
        items?: { id?: string; candidates?: string[] }[];
      }>(
        'Eres un médico docente. Eliges qué fragmentos de los videos de un curso explican el contenido de cada paso de un caso clínico, para recomendárselos al estudiante.',
        `${blocks.join('\n\n')}

Para cada paso elige hasta ${MAX_RESOURCES_PER_ITEM} candidatos cuyo fragmento EXPLIQUE el contenido del paso (el concepto, el criterio o la conducta). No basta con que compartan palabras sueltas o el tema general. Si ninguno lo explica, devuelve una lista vacía.

Responde SOLO con JSON: {"items":[{"id":"i0","candidates":["c0_1"]}]}`,
        0,
        60000,
      );
      for (const entry of res.items || []) {
        const k = Number(String(entry?.id || '').replace(/^i/, ''));
        const item = withCandidates[k];
        if (!item) continue;
        const list = candidates.get(item.id) || [];
        const kept: (typeof list)[number][] = [];
        for (const ref of entry.candidates || []) {
          const m = /^c(\d+)_(\d+)$/.exec(String(ref));
          const c = m && Number(m[1]) === k ? list[Number(m[2])] : undefined;
          // Mismo tramo, o el mismo contenido en otra actividad (p. ej. una
          // transcripción cargada en dos actividades): se recomienda una vez
          if (!c || kept.some((x) => sameMoment(x, c))) continue;
          kept.push(c);
        }
        item.resources = kept.slice(0, MAX_RESOURCES_PER_ITEM).map(toResource);
      }
    } catch (error) {
      this.logger.warn(
        `Verificación de recursos con IA falló: ${(error as Error).message}`,
      );
      for (const item of withCandidates) {
        item.resources = (candidates.get(item.id) || [])
          .slice(0, 1)
          .map(toResource);
      }
    }
  }

  /**
   * Completa `resources` de los ítems que cumplan `shouldFill` (por defecto,
   * los que no tienen). Modifica las etapas recibidas.
   */
  async fillStages(
    stages: CaseStage[],
    eventId: unknown,
    shouldFill: (item: CaseExpectedItem) => boolean = (i) =>
      !i.resources?.length,
  ) {
    const items = stages.flatMap((s) => s.expected).filter(shouldFill);
    if (!items.length) return;
    const activities = await this.courseActivities(eventId);
    if (!activities.size) return;
    for (let i = 0; i < items.length; i += RERANK_BATCH) {
      await this.resolveBatch(items.slice(i, i + RERANK_BATCH), activities);
    }
  }
}
