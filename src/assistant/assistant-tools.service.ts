import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Event } from 'src/events/schemas/event.schema';
import { Activity } from 'src/activities/schemas/activity.schema';
import { CourseAttendee } from 'src/course-attendee/schemas/course-attendee.schema';
import { ActivityAttendee } from 'src/activity-attendee/schemas/activity-attendee.schema';
import { Quiz } from 'src/quiz/schemas/quiz.schema';
import { UserQuizAttempt } from 'src/user-quiz-attempt/schemas/user-quiz-attempt.schema';
import { TranscriptSegmentsService } from 'src/transcript-segments/transcript-segments.service';
import { GenOnContextService } from 'src/genon/genon-context.service';
import {
  activityLink,
  formatTime,
  normalizeText,
  similarity,
} from 'src/ai-evaluations/practice-format';
import { ToolDeclaration } from './gemini-chat.client';

// Nota mínima por defecto de un examen (igual que el frontend)
const DEFAULT_PASS_MARK = 70;

const idVariants = (id: unknown): any[] => {
  const raw = String(id);
  return Types.ObjectId.isValid(raw) ? [raw, new Types.ObjectId(raw)] : [raw];
};

const baseUrl = () =>
  (process.env.WHATSAPP_REMINDER_BASE_URL || 'https://app.geniality.com.co').replace(
    /\/+$/,
    '',
  );

/** Persona a la que se le responde: todas las herramientas quedan atadas a ella. */
export interface AssistantScope {
  userId: string;
  organizationId: string;
}

interface OrgCourse {
  id: string;
  name: string;
  description: string;
}

export const ASSISTANT_TOOLS: ToolDeclaration[] = [
  {
    name: 'mis_cursos',
    description:
      'Cursos en los que está inscrita la persona en esta organización, con su avance, actividades terminadas, última actividad y la siguiente actividad pendiente con su enlace.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'estado_curso',
    description:
      'Detalle del avance de la persona en un curso: módulos y actividades (terminadas, en curso o pendientes), exámenes con su mejor nota y la nota mínima, y qué le falta para el certificado.',
    parameters: {
      type: 'object',
      properties: {
        curso: {
          type: 'string',
          description: 'Nombre (o parte del nombre) del curso. Vacío si solo tiene un curso.',
        },
      },
    },
  },
  {
    name: 'buscar_contenido',
    description:
      'Busca en las transcripciones de los videos de los cursos los fragmentos que explican un tema. Devuelve la actividad, el minuto, un enlace a ese minuto y el texto. Úsala para cualquier pregunta sobre el contenido académico.',
    parameters: {
      type: 'object',
      properties: {
        pregunta: { type: 'string', description: 'Tema o pregunta a buscar.' },
        curso: {
          type: 'string',
          description: 'Curso donde buscar (opcional; si no, en sus cursos).',
        },
      },
      required: ['pregunta'],
    },
  },
  {
    name: 'catalogo',
    description:
      'Cursos de la organización (aunque la persona no esté inscrita), con una descripción corta y su enlace.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'actividad',
    description:
      'Información de una actividad: curso, módulo, duración del video, descripción, si la persona ya la terminó y su enlace.',
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre (o parte) de la actividad.' },
        curso: { type: 'string', description: 'Curso (opcional).' },
      },
      required: ['nombre'],
    },
  },
];

/** Puntaje de qué tan bien un nombre coincide con lo que escribió la persona. */
function matchScore(name: string, query: string): number {
  const a = normalizeText(name);
  const b = normalizeText(query);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  return similarity(a, b);
}

function bestMatch<T>(items: T[], query: string, nameOf: (t: T) => string): T | null {
  let best: T | null = null;
  let score = 0;
  for (const item of items) {
    const s = matchScore(nameOf(item), query);
    if (s > score) {
      best = item;
      score = s;
    }
  }
  return score >= 0.45 ? best : null;
}

const stripHtml = (html: string) =>
  String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Herramientas del asistente: consultas de solo lectura atadas a la persona
 * y su organización (el modelo nunca elige de quién lee datos).
 */
@Injectable()
export class AssistantToolsService {
  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Activity.name) private readonly activityModel: Model<Activity>,
    @InjectModel(CourseAttendee.name)
    private readonly courseAttendeeModel: Model<CourseAttendee>,
    @InjectModel(ActivityAttendee.name)
    private readonly activityAttendeeModel: Model<ActivityAttendee>,
    @InjectModel(Quiz.name) private readonly quizModel: Model<Quiz>,
    @InjectModel(UserQuizAttempt.name)
    private readonly attemptModel: Model<UserQuizAttempt>,
    private readonly transcripts: TranscriptSegmentsService,
    private readonly context: GenOnContextService,
  ) {}

  async run(scope: AssistantScope, name: string, args: Record<string, any>) {
    switch (name) {
      case 'mis_cursos':
        return this.myCourses(scope);
      case 'estado_curso':
        return this.courseStatus(scope, String(args.curso || ''));
      case 'buscar_contenido':
        return this.searchContent(scope, String(args.pregunta || ''), String(args.curso || ''));
      case 'catalogo':
        return this.catalog(scope);
      case 'actividad':
        return this.activityInfo(scope, String(args.nombre || ''), String(args.curso || ''));
      default:
        throw new Error(`Herramienta desconocida: ${name}`);
    }
  }

  // ───────────────────────── Datos base ─────────────────────────

  /** Cursos de la organización. */
  async orgCourses(organizationId: string): Promise<OrgCourse[]> {
    const events = await this.eventModel.collection
      .find(
        { organizer_id: { $in: idVariants(organizationId) } },
        { projection: { name: 1, description: 1 } },
      )
      .toArray();
    return events.map((e: any) => ({
      id: String(e._id),
      name: String(e.name || 'Curso').trim(),
      description: stripHtml(e.description || '').slice(0, 300),
    }));
  }

  /** Inscripciones de la persona en cursos de la organización. */
  async enrollments(scope: AssistantScope) {
    const courses = await this.orgCourses(scope.organizationId);
    if (!courses.length) return [];
    const rows = await this.courseAttendeeModel.collection
      .find(
        {
          user_id: { $in: idVariants(scope.userId) },
          event_id: { $in: courses.flatMap((c) => idVariants(c.id)) },
        },
        { projection: { event_id: 1, progress: 1, createdAt: 1 } },
      )
      .toArray();
    const byId = new Map(courses.map((c) => [c.id, c]));
    return rows
      .map((r: any) => ({
        course: byId.get(String(r.event_id))!,
        progress: Math.round(Number(r.progress) || 0),
        enrolled_at: r.createdAt || null,
      }))
      .filter((r) => r.course);
  }

  /** Avance por actividad de la persona en un curso. */
  private async activityProgress(userId: string, activityIds: string[]) {
    if (!activityIds.length) return new Map<string, { progress: number; at: Date | null }>();
    const rows = await this.activityAttendeeModel.collection
      .find(
        {
          user_id: { $in: idVariants(userId) },
          activity_id: { $in: activityIds.flatMap(idVariants) },
        },
        { projection: { activity_id: 1, progress: 1, updatedAt: 1 } },
      )
      .toArray();
    const out = new Map<string, { progress: number; at: Date | null }>();
    for (const r of rows as any[]) {
      const id = String(r.activity_id);
      const prev = out.get(id);
      const progress = Math.min(100, Number(r.progress) || 0);
      if (!prev || progress > prev.progress) out.set(id, { progress, at: r.updatedAt || null });
    }
    return out;
  }

  /** Curso pedido (o el único en que está inscrita). */
  private async resolveCourse(scope: AssistantScope, query: string) {
    const mine = await this.enrollments(scope);
    if (query.trim()) {
      const all = await this.orgCourses(scope.organizationId);
      const preferred = bestMatch(mine.map((m) => m.course), query, (c) => c.name);
      return preferred || bestMatch(all, query, (c) => c.name);
    }
    return mine.length === 1 ? mine[0].course : null;
  }

  // ───────────────────────── Herramientas ─────────────────────────

  private async myCourses(scope: AssistantScope) {
    const mine = await this.enrollments(scope);
    if (!mine.length) {
      return { inscrito_en: [], nota: 'No está inscrita en ningún curso de esta organización.' };
    }
    const out: any[] = [];
    for (const m of mine) {
      const course = await this.context.loadCourse(m.course.id);
      const ids = (course?.activities || []).map((a) => a.id);
      const progress = await this.activityProgress(scope.userId, ids);
      const done = ids.filter((id) => (progress.get(id)?.progress || 0) >= 100).length;
      const pending = course?.activities.find((a) => (progress.get(a.id)?.progress || 0) < 100);
      const last = [...progress.values()]
        .map((p) => p.at)
        .filter(Boolean)
        .sort((a, b) => b!.getTime() - a!.getTime())[0];
      out.push({
        curso: m.course.name,
        avance: `${m.progress} %`,
        actividades_terminadas: `${done} de ${ids.length}`,
        ultima_actividad: last ? last.toISOString().slice(0, 10) : null,
        siguiente_actividad: pending
          ? {
              nombre: pending.name,
              modulo: pending.module_name,
              enlace: activityLink(scope.organizationId, pending.id),
            }
          : null,
        enlace_curso: `${baseUrl()}/organization/${scope.organizationId}/course/${m.course.id}`,
      });
    }
    return { inscrito_en: out };
  }

  private async courseStatus(scope: AssistantScope, query: string) {
    const match = await this.resolveCourse(scope, query);
    if (!match) {
      const mine = await this.enrollments(scope);
      return {
        error: query
          ? `No encontré un curso parecido a "${query}".`
          : 'Indica de qué curso: está inscrita en varios.',
        sus_cursos: mine.map((m) => m.course.name),
      };
    }
    const course = await this.context.loadCourse(match.id);
    if (!course) return { error: 'Ese curso ya no está disponible.' };
    const ids = course.activities.map((a) => a.id);
    const progress = await this.activityProgress(scope.userId, ids);

    const modules = new Map<string, { modulo: string; actividades: any[] }>();
    for (const a of course.activities) {
      const key = a.module_id || 'sin_modulo';
      const entry = modules.get(key) || { modulo: a.module_name || 'Sin módulo', actividades: [] };
      const p = progress.get(a.id)?.progress || 0;
      entry.actividades.push({
        nombre: a.name,
        estado: p >= 100 ? 'terminada' : p > 0 ? `en curso (${Math.round(p)} %)` : 'pendiente',
        enlace: activityLink(scope.organizationId, a.id),
      });
      modules.set(key, entry);
    }
    const completed = ids.filter((id) => (progress.get(id)?.progress || 0) >= 100).length;

    // Exámenes: mejor nota de la persona en cada uno
    const event: any = await this.eventModel.collection.findOne(
      { _id: new Types.ObjectId(match.id) },
      {
        projection: {
          certificate_gating_enabled: 1,
          certificate_required_activities: 1,
          certificate_required_exams: 1,
        },
      },
    );
    const quizzes = (
      await this.quizModel.collection
        .find(
          { eventId: { $in: idVariants(match.id) } },
          { projection: { id: 1, moduleId: 1, 'config.nota': 1, enabled: 1 } },
        )
        .toArray()
    ).filter((q: any) => q.enabled !== false);
    const keys = quizzes.flatMap((q: any) => [String(q._id), q.id].filter(Boolean));
    const attempts = keys.length
      ? await this.attemptModel.collection
          .find(
            { quizId: { $in: keys }, userId: { $in: idVariants(scope.userId).map(String) } },
            { projection: { quizId: 1, score: 1 } },
          )
          .toArray()
      : [];
    const moduleName = new Map(
      course.activities.filter((a) => a.module_id).map((a) => [a.module_id!, a.module_name]),
    );
    const exams = quizzes.map((q: any) => {
      const mine = attempts.filter(
        (a: any) => String(a.quizId) === String(q._id) || (q.id && a.quizId === q.id),
      );
      const best = mine.length ? Math.max(...mine.map((a: any) => Number(a.score) || 0)) : null;
      const pass = q.config?.nota ?? DEFAULT_PASS_MARK;
      return {
        examen: q.moduleId
          ? `Examen del ${moduleName.get(String(q.moduleId)) || 'módulo'}`
          : 'Examen final',
        nota_minima: pass,
        mejor_nota: best,
        estado: best === null ? 'sin presentar' : best >= pass ? 'aprobado' : 'no aprobado',
      };
    });

    const passedExams = exams.filter((e) => e.estado === 'aprobado').length;
    let certificado: string;
    if (!event?.certificate_gating_enabled) {
      certificado = 'El curso no tiene reglas de certificado configuradas.';
    } else {
      const missing: string[] = [];
      const needAct = event.certificate_required_activities;
      const needExams = event.certificate_required_exams;
      if (needAct != null && completed < needAct) {
        missing.push(`${needAct - completed} actividades`);
      }
      if (needExams != null && passedExams < needExams) {
        missing.push(`${needExams - passedExams} exámenes aprobados`);
      }
      certificado = missing.length
        ? `Le falta: ${missing.join(' y ')}.`
        : 'Cumple los requisitos: puede descargar su certificado en el curso.';
    }

    return {
      curso: course.eventName,
      actividades_terminadas: `${completed} de ${ids.length}`,
      modulos: [...modules.values()],
      examenes: exams,
      certificado,
      enlace_curso: `${baseUrl()}/organization/${scope.organizationId}/course/${match.id}`,
    };
  }

  private async searchContent(scope: AssistantScope, question: string, courseQuery: string) {
    if (!question.trim()) return { error: 'Falta el tema a buscar.' };
    let courseIds: string[];
    if (courseQuery.trim()) {
      const match = await this.resolveCourse(scope, courseQuery);
      courseIds = match ? [match.id] : [];
    } else {
      const mine = await this.enrollments(scope);
      courseIds = (mine.length ? mine.map((m) => m.course) : await this.orgCourses(scope.organizationId)).map(
        (c) => c.id,
      );
    }
    const activities: { id: string; name: string; course: string }[] = [];
    for (const id of courseIds.slice(0, 20)) {
      const course = await this.context.loadCourse(id);
      for (const a of course?.activities || []) {
        activities.push({ id: a.id, name: a.name, course: course!.eventName });
      }
    }
    if (!activities.length) return { resultados: [], nota: 'No hay contenido para buscar.' };
    const byId = new Map(activities.map((a) => [a.id, a]));
    const found = await this.transcripts.searchCandidatesInActivities(
      question,
      activities.map((a) => a.id),
      5,
    );
    return {
      resultados: found.map((f) => {
        const a = byId.get(String(f.activity_id));
        return {
          curso: a?.course || '',
          actividad: a?.name || f.name_activity || 'Actividad',
          minuto: formatTime(f.startTime),
          enlace: activityLink(scope.organizationId, f.activity_id, f.startTime),
          fragmento: f.context,
        };
      }),
    };
  }

  private async catalog(scope: AssistantScope) {
    const [courses, mine] = await Promise.all([
      this.orgCourses(scope.organizationId),
      this.enrollments(scope),
    ]);
    const enrolled = new Set(mine.map((m) => m.course.id));
    return {
      cursos: courses.slice(0, 40).map((c) => ({
        curso: c.name,
        descripcion: c.description,
        inscrita: enrolled.has(c.id),
        enlace: `${baseUrl()}/organization/${scope.organizationId}/course/${c.id}`,
      })),
    };
  }

  private async activityInfo(scope: AssistantScope, name: string, courseQuery: string) {
    if (!name.trim()) return { error: 'Falta el nombre de la actividad.' };
    const courses = courseQuery.trim()
      ? [await this.resolveCourse(scope, courseQuery)].filter(Boolean)
      : await this.orgCourses(scope.organizationId);
    const candidates: { id: string; name: string; module: string | null; course: string; seconds: number | null }[] = [];
    for (const c of (courses as OrgCourse[]).slice(0, 20)) {
      const course = await this.context.loadCourse(c.id);
      for (const a of course?.activities || []) {
        candidates.push({
          id: a.id,
          name: a.name,
          module: a.module_name,
          course: course!.eventName,
          seconds: a.video_seconds,
        });
      }
    }
    const a = bestMatch(candidates, name, (x) => x.name);
    if (!a) return { error: `No encontré una actividad parecida a "${name}".` };
    const [doc, progress]: [any, Map<string, { progress: number }>] = await Promise.all([
      this.activityModel.collection.findOne(
        { _id: new Types.ObjectId(a.id) },
        { projection: { description: 1, short_description: 1 } },
      ),
      this.activityProgress(scope.userId, [a.id]),
    ]);
    const p = progress.get(a.id)?.progress || 0;
    return {
      actividad: a.name,
      curso: a.course,
      modulo: a.module,
      duracion_video: a.seconds ? `${Math.max(1, Math.round(a.seconds / 60))} minutos` : null,
      descripcion: stripHtml(doc?.short_description || doc?.description || '').slice(0, 500) || null,
      estado: p >= 100 ? 'terminada' : p > 0 ? `en curso (${Math.round(p)} %)` : 'pendiente',
      enlace: activityLink(scope.organizationId, a.id),
    };
  }
}
