import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomInt } from 'crypto';
import { Model, Types } from 'mongoose';
import { UsersService } from 'src/users/users.service';
import { Event } from 'src/events/schemas/event.schema';
import { CourseAttendee } from 'src/course-attendee/schemas/course-attendee.schema';
import { AiEvaluationSession } from './schemas/ai-evaluation-session.schema';
import { AiEvaluationResult } from './schemas/ai-evaluation-result.schema';
import {
  AiEvaluationContext,
  AiEvaluationDifficulty,
} from './schemas/ai-evaluation-context.schema';
import {
  CourseContentService,
  DEFAULT_NUM_QUESTIONS,
  DEFAULT_PASSING_SCORE,
  idVariants,
} from './course-content.service';
import { GeminiTextClient } from './gemini-text.client';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I
const CODE_TTL_MINUTES =
  Number(process.env.AI_EVALUATION_CODE_TTL_MINUTES) || 60;
const DIFFICULTIES: AiEvaluationDifficulty[] = [
  'basic',
  'intermediate',
  'advanced',
  'mixed',
];

/** `course` en la ruta = contexto de todo el curso (module_id null). */
export const COURSE_KEY = 'course';

export interface StartEvaluationResponse {
  session_id: string;
  code: string;
  whatsapp_url: string;
  expires_at: Date;
  event_name: string;
  modules: { id: string; name: string }[];
}

export interface UpsertContextBody {
  enabled?: boolean;
  content?: string;
  learning_objectives?: string[];
  instructions?: string;
  document_ids?: string[];
  fixed_questions?: string[];
  num_questions?: number | null;
  passing_score?: number | null;
  difficulty?: AiEvaluationDifficulty;
}

function cleanStrings(list: unknown): string[] {
  return Array.isArray(list)
    ? list.map((s) => String(s).trim()).filter(Boolean)
    : [];
}

function optionalInt(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new BadRequestException(`Valor fuera de rango (${min}-${max})`);
  }
  return n;
}

@Injectable()
export class AiEvaluationsService {
  constructor(
    @InjectModel(AiEvaluationSession.name)
    private readonly sessionModel: Model<AiEvaluationSession>,
    @InjectModel(AiEvaluationResult.name)
    private readonly resultModel: Model<AiEvaluationResult>,
    @InjectModel(AiEvaluationContext.name)
    private readonly contextModel: Model<AiEvaluationContext>,
    @InjectModel(Event.name)
    private readonly eventModel: Model<Event>,
    @InjectModel(CourseAttendee.name)
    private readonly courseAttendeeModel: Model<CourseAttendee>,
    private readonly usersService: UsersService,
    private readonly content: CourseContentService,
    private readonly gemini: GeminiTextClient,
  ) {}

  // ─── Estudiante ────────────────────────────────────────────────────────

  /**
   * Crea una sesión pendiente y devuelve el link wa.me con el código
   * pre-llenado. Solo para estudiantes inscritos en el curso.
   */
  async start(
    uid: string,
    eventId: string,
    moduleId?: string,
  ): Promise<StartEvaluationResponse> {
    const number = (process.env.AI_EVALUATION_WHATSAPP_NUMBER || '').replace(
      /\D/g,
      '',
    );
    if (!number) {
      throw new ServiceUnavailableException(
        'AI_EVALUATION_WHATSAPP_NUMBER no está configurado en este ambiente',
      );
    }

    const user = await this.usersService.findByFirebaseUid(uid);
    const event = await this.findEvent(eventId);
    if (!(await this.isCourseEnabled(eventId))) {
      throw new ForbiddenException(
        'La evaluación con IA no está habilitada en este curso',
      );
    }

    const enrolled = await this.courseAttendeeModel
      .exists({
        user_id: { $in: idVariants(user._id) },
        event_id: { $in: idVariants(eventId) },
      })
      .exec();
    if (!enrolled) {
      throw new ForbiddenException('No estás inscrito en este curso');
    }

    const modules = await this.availableModules(eventId);
    const preset = moduleId ? modules.find((m) => m.id === moduleId) : null;
    if (moduleId && !preset) {
      throw new BadRequestException(
        'El módulo no pertenece al curso o no tiene la evaluación habilitada',
      );
    }

    const base = {
      event_id: event._id,
      event_name: event.name,
      organization_id: event.organizer_id,
      user_id: user._id,
      user_name: user.names,
      modules,
      module_id: preset?.id ?? null,
      module_name: preset?.name ?? null,
      code_expires_at: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000),
    };

    // Reintenta ante la improbable colisión del código (índice único)
    let session: AiEvaluationSession | null = null;
    for (let attempt = 0; attempt < 5 && !session; attempt++) {
      const code =
        'EV-' +
        Array.from(
          { length: 6 },
          () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
        ).join('');
      try {
        session = await this.sessionModel.create({ ...base, code });
      } catch (error) {
        if ((error as any)?.code !== 11000) throw error;
      }
    }
    if (!session) {
      throw new ServiceUnavailableException(
        'No se pudo generar un código de evaluación',
      );
    }

    const text = `Hola, quiero evaluar mis conocimientos del curso "${event.name}". Código: ${session.code}`;
    return {
      session_id: String(session._id),
      code: session.code,
      whatsapp_url: `https://wa.me/${number}?text=${encodeURIComponent(text)}`,
      expires_at: session.code_expires_at,
      event_name: event.name,
      modules,
    };
  }

  /** Si el curso tiene la evaluación habilitada y qué módulos ofrece. */
  async availability(eventId: string) {
    if (!Types.ObjectId.isValid(eventId)) {
      return { enabled: false, modules: [] };
    }
    const enabled = await this.isCourseEnabled(eventId);
    return {
      enabled,
      modules: enabled ? await this.availableModules(eventId) : [],
    };
  }

  /** Resultados del usuario autenticado en un curso (más recientes primero). */
  async findMyResults(uid: string, eventId: string) {
    const user = await this.usersService.findByFirebaseUid(uid);
    return this.resultModel
      .find({
        user_id: { $in: idVariants(user._id) },
        event_id: { $in: idVariants(eventId) },
      })
      .select('-questions.key_points')
      .sort({ created_at: -1 })
      .lean()
      .exec();
  }

  /** Sesión (con historial de mensajes) del usuario autenticado. */
  async findMySession(uid: string, sessionId: string) {
    const user = await this.usersService.findByFirebaseUid(uid);
    if (!Types.ObjectId.isValid(sessionId)) {
      throw new NotFoundException('Sesión no encontrada');
    }
    const session = await this.sessionModel
      .findById(sessionId)
      .select('-questions.key_points -code')
      .lean()
      .exec();
    if (!session || String(session.user_id) !== String(user._id)) {
      throw new NotFoundException('Sesión no encontrada');
    }
    return session;
  }

  // ─── Admin ─────────────────────────────────────────────────────────────

  /** Módulos del curso con su contexto de evaluación (o null si no tiene). */
  async listContexts(organizationId: string, eventId: string) {
    await this.findEventInOrg(organizationId, eventId);
    const [modules, contexts] = await Promise.all([
      this.content.listModules(eventId),
      this.contextModel
        .find({ event_id: new Types.ObjectId(eventId) })
        .lean()
        .exec(),
    ]);
    const byModule = new Map(contexts.map((c) => [c.module_id, c]));
    return {
      enabled: byModule.get(null)?.enabled === true,
      defaults: {
        num_questions: DEFAULT_NUM_QUESTIONS,
        passing_score: DEFAULT_PASSING_SCORE,
      },
      course: byModule.get(null) || null,
      modules: modules.map((m) => ({
        ...m,
        context: byModule.get(m.id) || null,
      })),
    };
  }

  async upsertContext(
    organizationId: string,
    eventId: string,
    moduleKey: string,
    body: UpsertContextBody,
    uid: string,
  ) {
    const event = await this.findEventInOrg(organizationId, eventId);
    const moduleId = await this.resolveModuleKey(eventId, moduleKey);
    const user = await this.usersService.findByFirebaseUid(uid);

    const update: Record<string, any> = {
      organization_id: event.organizer_id,
      updated_by: user._id,
    };
    if (body.enabled !== undefined) update.enabled = Boolean(body.enabled);
    if (body.content !== undefined) update.content = String(body.content);
    if (body.instructions !== undefined) {
      update.instructions = String(body.instructions).trim();
    }
    if (body.learning_objectives !== undefined) {
      update.learning_objectives = cleanStrings(body.learning_objectives);
    }
    if (body.fixed_questions !== undefined) {
      update.fixed_questions = cleanStrings(body.fixed_questions);
    }
    if (body.document_ids !== undefined) {
      update.document_ids = cleanStrings(body.document_ids).filter((id) =>
        Types.ObjectId.isValid(id),
      );
    }
    if (body.num_questions !== undefined) {
      update.num_questions = optionalInt(body.num_questions, 1, 15);
    }
    if (body.passing_score !== undefined) {
      update.passing_score = optionalInt(body.passing_score, 0, 100);
    }
    if (body.difficulty !== undefined) {
      if (!DIFFICULTIES.includes(body.difficulty)) {
        throw new BadRequestException('Dificultad inválida');
      }
      update.difficulty = body.difficulty;
    }

    return this.contextModel
      .findOneAndUpdate(
        { event_id: event._id, module_id: moduleId },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .lean()
      .exec();
  }

  async deleteContext(
    organizationId: string,
    eventId: string,
    moduleKey: string,
  ) {
    const event = await this.findEventInOrg(organizationId, eventId);
    const moduleId = await this.resolveModuleKey(eventId, moduleKey);
    await this.contextModel
      .deleteOne({ event_id: event._id, module_id: moduleId })
      .exec();
    return { deleted: true };
  }

  /**
   * Borrador del contexto generado por IA a partir del contenido en bruto del
   * módulo. No se guarda: el admin lo revisa y lo guarda con upsertContext.
   */
  async generateDraft(
    organizationId: string,
    eventId: string,
    moduleKey: string,
  ) {
    const event = await this.findEventInOrg(organizationId, eventId);
    const moduleId = await this.resolveModuleKey(eventId, moduleKey);
    const raw = await this.content.rawContent(event, moduleId);
    if (raw.length < 300) {
      throw new BadRequestException(
        'El módulo no tiene contenido suficiente (transcripciones, descripciones o documentos) para generar un borrador',
      );
    }

    const draft = await this.gemini.generateJson<{
      content?: string;
      learning_objectives?: string[];
    }>(
      'Eres un diseñador instruccional. Conviertes material de curso (transcripciones de clases, descripciones y documentos) en material de referencia claro para evaluar a los estudiantes.',
      `A partir del material de abajo, escribe en ${event.language === 'en' ? 'inglés' : 'español'}:
1. "content": un documento de referencia en Markdown, organizado por temas con encabezados, con los conceptos clave, definiciones, procesos, datos importantes y ejemplos que se enseñan. Elimina muletillas, saludos y repeticiones propias del habla. Entre 800 y 2500 palabras según la cantidad de material.
2. "learning_objectives": 3 a 8 objetivos de aprendizaje concretos y evaluables ("Explicar...", "Diferenciar...", "Aplicar...").

Usa SOLO información presente en el material.

Responde SOLO con JSON: {"content": "...", "learning_objectives": ["..."]}

MATERIAL:
${raw}`,
      0.3,
    );

    return {
      content: String(draft.content || ''),
      learning_objectives: cleanStrings(draft.learning_objectives),
      source_chars: raw.length,
    };
  }

  /** Resultados de todos los estudiantes del curso. */
  async findEventResults(organizationId: string, eventId: string) {
    await this.findEventInOrg(organizationId, eventId);
    return this.resultModel
      .find({ event_id: { $in: idVariants(eventId) } })
      .sort({ created_at: -1 })
      .lean()
      .exec();
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /**
   * La evaluación es opt-in por curso: se habilita con el contexto de todo el
   * curso (module_id null) con enabled = true.
   */
  private async isCourseEnabled(eventId: string): Promise<boolean> {
    const course = await this.contextModel
      .exists({
        event_id: new Types.ObjectId(eventId),
        module_id: null,
        enabled: true,
      })
      .exec();
    return Boolean(course);
  }

  /** Módulos que se ofrecen al estudiante (excluye los deshabilitados). */
  private async availableModules(eventId: string) {
    const [modules, disabled] = await Promise.all([
      this.content.listModules(eventId),
      this.contextModel
        .find({ event_id: new Types.ObjectId(eventId), enabled: false })
        .select('module_id')
        .lean()
        .exec(),
    ]);
    const off = new Set(disabled.map((c) => c.module_id));
    return modules.filter((m) => !off.has(m.id));
  }

  private async resolveModuleKey(
    eventId: string,
    moduleKey: string,
  ): Promise<string | null> {
    if (moduleKey === COURSE_KEY) return null;
    const modules = await this.content.listModules(eventId);
    if (!modules.some((m) => m.id === moduleKey)) {
      throw new NotFoundException('Módulo no encontrado en este curso');
    }
    return moduleKey;
  }

  private async findEvent(eventId: string): Promise<Event> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new NotFoundException('Curso no encontrado');
    }
    const event = await this.eventModel.findById(eventId).exec();
    if (!event) throw new NotFoundException('Curso no encontrado');
    return event;
  }

  private async findEventInOrg(
    organizationId: string,
    eventId: string,
  ): Promise<Event> {
    const event = await this.findEvent(eventId);
    if (String(event.organizer_id) !== String(organizationId)) {
      throw new NotFoundException('Curso no encontrado en esta organización');
    }
    return event;
  }
}
