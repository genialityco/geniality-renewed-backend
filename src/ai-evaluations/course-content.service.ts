import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Event } from 'src/events/schemas/event.schema';
import { Module as CourseModule } from 'src/modules/schemas/module.schema';
import { Activity } from 'src/activities/schemas/activity.schema';
import {
  TranscriptSegment,
  TranscriptSegmentDocument,
} from 'src/transcript-segments/schemas/transcript-segment.schema';
import {
  Document as CourseDocument,
  DocumentDocument,
} from 'src/documents/schemas/document.schema';
import {
  AiEvaluationContext,
  AiEvaluationDifficulty,
} from './schemas/ai-evaluation-context.schema';

/** ids guardados como string u ObjectId según cómo se insertó el registro */
export function idVariants(id: unknown): any[] {
  const variants: any[] = [String(id)];
  if (Types.ObjectId.isValid(String(id))) {
    variants.push(new Types.ObjectId(String(id)));
  }
  return variants;
}

export interface EvaluationMaterial {
  source: 'context' | 'raw';
  content: string;
  learningObjectives: string[];
  instructions: string;
  fixedQuestions: string[];
  difficulty: AiEvaluationDifficulty;
  numQuestions: number;
  passingScore: number;
}

export const DEFAULT_NUM_QUESTIONS =
  Number(process.env.AI_EVALUATION_NUM_QUESTIONS) || 5;
export const DEFAULT_PASSING_SCORE =
  Number(process.env.AI_EVALUATION_PASSING_SCORE) || 70;
const MAX_CONTEXT_CHARS =
  Number(process.env.AI_EVALUATION_MAX_CONTEXT_CHARS) || 60000;

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Arma el material de referencia de un módulo (o de todo el curso) para la
 * evaluación: el contexto curado por el admin si existe, o el contenido en
 * bruto (actividades + transcripciones + documentos) si no.
 */
@Injectable()
export class CourseContentService {
  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel('Module') private readonly moduleModel: Model<CourseModule>,
    @InjectModel(Activity.name)
    private readonly activityModel: Model<Activity>,
    @InjectModel(TranscriptSegment.name)
    private readonly segmentModel: Model<TranscriptSegmentDocument>,
    @InjectModel(CourseDocument.name)
    private readonly documentModel: Model<DocumentDocument>,
    @InjectModel(AiEvaluationContext.name)
    private readonly contextModel: Model<AiEvaluationContext>,
  ) {}

  async listModules(eventId: string): Promise<{ id: string; name: string }[]> {
    const modules = await this.moduleModel
      .find({ event_id: { $in: idVariants(eventId) } })
      .sort({ order: 1 })
      .lean()
      .exec();
    return modules.map((m: any) => ({
      id: String(m._id),
      name: m.module_name || 'Módulo',
    }));
  }

  findContext(eventId: string, moduleId: string | null) {
    return this.contextModel
      .findOne({ event_id: new Types.ObjectId(eventId), module_id: moduleId })
      .lean()
      .exec();
  }

  /** Material listo para generar/calificar preguntas. */
  async getMaterial(
    event: Event,
    moduleId: string | null,
  ): Promise<EvaluationMaterial> {
    const ctx = await this.findContext(String(event._id), moduleId);
    const base = {
      learningObjectives: ctx?.learning_objectives || [],
      instructions: ctx?.instructions || '',
      fixedQuestions: ctx?.fixed_questions || [],
      difficulty: ctx?.difficulty || 'mixed',
      numQuestions: ctx?.num_questions || DEFAULT_NUM_QUESTIONS,
      passingScore: ctx?.passing_score ?? DEFAULT_PASSING_SCORE,
    };

    if (ctx?.content?.trim()) {
      const parts = [`CURSO: ${event.name}`, ctx.content.trim()];
      if (ctx.document_ids?.length) {
        parts.push(await this.documentsText(ctx.document_ids));
      }
      return {
        ...base,
        source: 'context',
        content: parts.join('\n\n').slice(0, MAX_CONTEXT_CHARS),
      };
    }

    return {
      ...base,
      source: 'raw',
      content: await this.rawContent(event, moduleId),
    };
  }

  /** Contenido en bruto: descripción + actividades con transcripción + documentos. */
  async rawContent(event: Event, moduleId: string | null): Promise<string> {
    const query: Record<string, any> = {
      event_id: { $in: idVariants(event._id) },
    };
    if (moduleId) query.module_id = { $in: idVariants(moduleId) };

    const activities = await this.activityModel
      .find(query)
      .select('name description short_description textTranscription')
      .lean()
      .exec();

    // Transcripción por segmentos para las actividades sin texto consolidado
    const missing = activities
      .filter((a) => !a.textTranscription)
      .flatMap((a) => idVariants(a._id));
    const segments = new Map<string, string[]>();
    if (missing.length) {
      const docs = await this.segmentModel
        .find({ activity_id: { $in: missing } })
        .select('activity_id text')
        .sort({ startTime: 1 })
        .lean()
        .exec();
      for (const seg of docs) {
        const key = String(seg.activity_id);
        if (!segments.has(key)) segments.set(key, []);
        segments.get(key).push(seg.text || '');
      }
    }

    const perActivity = Math.max(
      3000,
      Math.floor(MAX_CONTEXT_CHARS / Math.max(activities.length, 1)),
    );
    const parts = [`CURSO: ${event.name}`];
    if (event.description) {
      parts.push(
        `DESCRIPCIÓN DEL CURSO: ${stripHtml(event.description).slice(0, 2000)}`,
      );
    }
    for (const act of activities) {
      const block = [`\n### Actividad: ${act.name || 'Actividad'}`];
      const desc = act.description || act.short_description;
      if (desc) block.push(`Descripción: ${stripHtml(desc).slice(0, 1500)}`);
      const transcript =
        act.textTranscription ||
        (segments.get(String(act._id)) || []).join(' ');
      if (transcript) {
        block.push(`Transcripción: ${transcript.slice(0, perActivity)}`);
      }
      parts.push(block.join('\n'));
    }

    // Documentos asociados al curso (y al módulo, si aplica)
    const docQuery: Record<string, any> = {
      eventId: { $in: idVariants(event._id) },
      active: true,
    };
    if (moduleId) docQuery.moduleId = { $in: idVariants(moduleId) };
    const docs = await this.documentModel
      .find(docQuery)
      .select('name content')
      .lean()
      .exec();
    for (const doc of docs) {
      if (doc.content) {
        parts.push(
          `\n### Documento: ${doc.name}\n${doc.content.slice(0, perActivity)}`,
        );
      }
    }

    return parts.join('\n').slice(0, MAX_CONTEXT_CHARS);
  }

  private async documentsText(documentIds: string[]): Promise<string> {
    const ids = documentIds.filter((id) => Types.ObjectId.isValid(id));
    if (!ids.length) return '';
    const docs = await this.documentModel
      .find({ _id: { $in: ids } })
      .select('name content')
      .lean()
      .exec();
    return docs
      .filter((d) => d.content)
      .map((d) => `### Documento: ${d.name}\n${d.content}`)
      .join('\n\n');
  }
}
