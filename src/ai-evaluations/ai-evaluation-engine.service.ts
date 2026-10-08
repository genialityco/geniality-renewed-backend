import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Event } from 'src/events/schemas/event.schema';
import {
  ACTIVE_STATUSES,
  AiEvaluationQuestion,
  AiEvaluationSession,
} from './schemas/ai-evaluation-session.schema';
import { AiEvaluationResult } from './schemas/ai-evaluation-result.schema';
import {
  CourseContentService,
  EvaluationMaterial,
} from './course-content.service';
import { GeminiTextClient } from './gemini-text.client';

export const CODE_PATTERN = /\bEV-?([A-Z2-9]{6})\b/i;
const CANCEL_WORDS = new Set([
  'cancelar',
  'salir',
  'terminar',
  'detener',
  'parar',
  'stop',
]);
const WHOLE_COURSE_WORDS = new Set([
  'todo',
  'todos',
  'todo el curso',
  'curso completo',
  'el curso completo',
]);
const SESSION_IDLE_HOURS =
  Number(process.env.AI_EVALUATION_SESSION_TTL_HOURS) || 24;
const MIN_CONTENT_CHARS = 300;

const DIFFICULTY_HINT: Record<string, string> = {
  basic: 'Preguntas de nivel básico: definiciones y comprensión de conceptos.',
  intermediate:
    'Preguntas de nivel intermedio: relación entre conceptos y explicación de procesos.',
  advanced:
    'Preguntas de nivel avanzado: análisis, aplicación a casos prácticos y toma de decisiones.',
  mixed:
    'Mezcla niveles: comprensión de conceptos, relación entre ideas y aplicación a un caso práctico.',
};

type Session = AiEvaluationSession;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Similitud simple entre textos normalizados (Dice sobre bigramas). */
function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) || 0);
  const total = Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0);
  return total ? (2 * inter) / total : 0;
}

/**
 * Conversación de evaluación por WhatsApp (iniciada con un código EV-XXXXXX).
 * WhatsappInboundService recibe los mensajes, los enruta aquí y envía la
 * respuesta. El estado vive en `ai_evaluation_sessions`.
 */
@Injectable()
export class AiEvaluationEngineService {
  private readonly logger = new Logger(AiEvaluationEngineService.name);

  constructor(
    @InjectModel(AiEvaluationSession.name)
    private readonly sessionModel: Model<AiEvaluationSession>,
    @InjectModel(AiEvaluationResult.name)
    private readonly resultModel: Model<AiEvaluationResult>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    private readonly content: CourseContentService,
    private readonly gemini: GeminiTextClient,
  ) {}

  /** ¿El teléfono tiene una evaluación en curso (no vencida)? */
  async hasActiveSession(phone: string): Promise<boolean> {
    return Boolean(await this.findActiveSession(phone));
  }

  /**
   * Devuelve el texto a responder, o null si el mensaje no pertenece a una
   * evaluación (sin código y sin sesión activa) y se ignora.
   */
  async handleMessage(phone: string, text: string): Promise<string | null> {
    const codeMatch = text.match(CODE_PATTERN);
    if (codeMatch) {
      return this.startFromCode(
        phone,
        `EV-${codeMatch[1].toUpperCase()}`,
        text,
      );
    }

    const session = await this.findActiveSession(phone);
    if (!session) return null;

    await this.log(session, 'user', text);
    let reply: string;
    if (CANCEL_WORDS.has(normalize(text))) {
      await this.update(session, {
        status: 'cancelled',
        finished_at: new Date(),
      });
      reply =
        'Evaluación cancelada. Puedes iniciar una nueva desde el curso cuando quieras. 👋';
    } else if (session.status === 'selecting_module') {
      reply = await this.handleModuleSelection(session, text);
    } else {
      reply = await this.handleAnswer(session, text);
    }
    await this.log(session, 'assistant', reply);
    return reply;
  }

  // ─── Estado ────────────────────────────────────────────────────────────

  private async findActiveSession(phone: string): Promise<Session | null> {
    const session = await this.sessionModel
      .findOne({ phone, status: { $in: ACTIVE_STATUSES } })
      .sort({ updated_at: -1 })
      .exec();
    if (!session) return null;
    const idleMs = Date.now() - session.updated_at.getTime();
    if (idleMs > SESSION_IDLE_HOURS * 3600 * 1000) {
      await this.update(session, { status: 'expired' });
      return null;
    }
    return session;
  }

  private async update(
    session: Session,
    fields: Partial<AiEvaluationSession> | Record<string, any>,
  ): Promise<void> {
    await this.sessionModel
      .updateOne({ _id: session._id }, { $set: fields })
      .exec();
    for (const [key, value] of Object.entries(fields)) {
      if (!key.includes('.')) (session as any)[key] = value;
    }
  }

  private async log(
    session: Session,
    role: 'user' | 'assistant',
    content: string,
  ): Promise<void> {
    await this.sessionModel
      .updateOne(
        { _id: session._id },
        { $push: { messages: { role, content, created_at: new Date() } } },
      )
      .exec();
  }

  // ─── Inicio con código ─────────────────────────────────────────────────

  private async startFromCode(
    phone: string,
    code: string,
    text: string,
  ): Promise<string> {
    const session = await this.sessionModel.findOne({ code }).exec();
    if (!session) {
      return 'No encontré una evaluación con ese código. Vuelve al curso y pulsa de nuevo *Evaluar tus conocimientos*.';
    }

    if (ACTIVE_STATUSES.includes(session.status)) {
      if (session.phone !== phone) {
        return 'Este código ya está siendo usado desde otro número. Genera uno nuevo desde el curso.';
      }
      return this.currentPrompt(session);
    }
    if (session.status !== 'pending') {
      return 'Este código ya fue utilizado. Genera uno nuevo desde el curso para volver a evaluarte.';
    }
    if (Date.now() > session.code_expires_at.getTime()) {
      await this.update(session, { status: 'expired' });
      return 'Este código expiró. Genera uno nuevo desde el curso con el botón *Evaluar tus conocimientos*.';
    }

    // Solo una evaluación activa por teléfono
    await this.sessionModel
      .updateMany(
        { phone, status: { $in: ACTIVE_STATUSES } },
        { $set: { status: 'cancelled', finished_at: new Date() } },
      )
      .exec();
    await this.update(session, {
      phone,
      status: 'selecting_module',
      started_at: new Date(),
    });
    await this.log(session, 'user', text);

    const firstName = (session.user_name || '').split(' ')[0];
    const greeting =
      `¡Hola${firstName ? ' ' + firstName : ''}! 👋 Vamos a evaluar tus conocimientos del curso *${session.event_name}*.\n` +
      'Te haré algunas preguntas abiertas; responde con tus palabras. ' +
      'Escribe *cancelar* en cualquier momento para salir.';

    let next: string;
    if (session.module_id) {
      next = await this.beginQuestions(
        session,
        session.module_id,
        session.module_name,
      );
    } else if (!session.modules.length) {
      next = await this.beginQuestions(session, null, null);
    } else {
      next = this.moduleMenu(session);
    }

    const reply = `${greeting}\n\n${next}`;
    await this.log(session, 'assistant', reply);
    return reply;
  }

  private moduleMenu(session: Session): string {
    const lines = [
      '¿Sobre qué módulo quieres que te evalúe? Responde con el número:',
    ];
    session.modules.forEach((m, i) => lines.push(`*${i + 1}.* ${m.name}`));
    lines.push('*0.* Todo el curso');
    return lines.join('\n');
  }

  private currentPrompt(session: Session): string {
    if (session.status === 'selecting_module') return this.moduleMenu(session);
    const idx = session.current_question;
    const q = session.questions[idx];
    return `Seguimos donde quedamos.\n\n*Pregunta ${idx + 1}/${session.questions.length}:* ${q.question}`;
  }

  // ─── Selección de módulo ───────────────────────────────────────────────

  private async handleModuleSelection(
    session: Session,
    text: string,
  ): Promise<string> {
    const choice = normalize(text);

    if (session.retry_module && choice === 'reintentar') {
      return this.beginQuestions(
        session,
        session.retry_module.id,
        session.retry_module.name,
      );
    }

    const number = text.trim().match(/^(\d{1,3})\.?$/);
    if (number) {
      const n = Number(number[1]);
      if (n === 0) return this.beginQuestions(session, null, null);
      const mod = session.modules[n - 1];
      if (mod) return this.beginQuestions(session, mod.id, mod.name);
      return 'No reconocí esa opción. ' + this.moduleMenu(session);
    }
    if (WHOLE_COURSE_WORDS.has(choice)) {
      return this.beginQuestions(session, null, null);
    }

    let best: { id: string; name: string } | null = null;
    let bestScore = 0;
    for (const m of session.modules) {
      const name = normalize(m.name);
      const score =
        choice && (name.includes(choice) || choice.includes(name))
          ? 1
          : similarity(choice, name);
      if (score > bestScore) {
        best = m;
        bestScore = score;
      }
    }
    if (!best || bestScore < 0.6) {
      return 'No reconocí esa opción. ' + this.moduleMenu(session);
    }
    return this.beginQuestions(session, best.id, best.name);
  }

  // ─── Generación de preguntas ───────────────────────────────────────────

  private async beginQuestions(
    session: Session,
    moduleId: string | null,
    moduleName: string | null,
  ): Promise<string> {
    const event = await this.eventModel.findById(session.event_id).exec();
    if (!event) {
      await this.update(session, {
        status: 'cancelled',
        finished_at: new Date(),
      });
      return 'Este curso ya no está disponible.';
    }

    const material = await this.content.getMaterial(event, moduleId);
    if (material.content.length < MIN_CONTENT_CHARS) {
      if (session.modules.length && !session.module_id) {
        return (
          'Ese módulo aún no tiene suficiente contenido para evaluarte. ' +
          this.moduleMenu(session)
        );
      }
      await this.update(session, {
        status: 'cancelled',
        finished_at: new Date(),
      });
      return 'Este contenido aún no tiene material suficiente para generar una evaluación. Inténtalo más adelante.';
    }

    let questions: AiEvaluationQuestion[] = [];
    try {
      questions = await this.generateQuestions(
        event,
        moduleName ? `el módulo "${moduleName}"` : 'todo el curso',
        material,
      );
    } catch (error) {
      this.logger.error(
        `Error generando preguntas session=${session._id}: ${(error as Error).message}`,
      );
    }

    if (!questions.length) {
      await this.update(session, {
        retry_module: { id: moduleId, name: moduleName },
      });
      return 'Tuve un problema preparando las preguntas. Responde *reintentar* para intentarlo de nuevo.';
    }

    const scope = moduleName || 'Todo el curso';
    await this.update(session, {
      status: 'in_progress',
      module_id: moduleId,
      module_name: scope,
      questions,
      current_question: 0,
      passing_score: material.passingScore,
      retry_module: null,
    });
    return `Perfecto, evaluaremos *${scope}*. Serán ${questions.length} preguntas.\n\n*Pregunta 1/${questions.length}:* ${questions[0].question}`;
  }

  private async generateQuestions(
    event: Event,
    scope: string,
    material: EvaluationMaterial,
  ): Promise<AiEvaluationQuestion[]> {
    const language = event.language === 'en' ? 'inglés' : 'español';
    const n = material.numQuestions;
    const extra: string[] = [];
    if (material.learningObjectives.length) {
      extra.push(
        'Objetivos de aprendizaje (cada pregunta debe evaluar al menos uno, cubriéndolos todos en lo posible):\n' +
          material.learningObjectives.map((o) => `- ${o}`).join('\n'),
      );
    }
    if (material.instructions) {
      extra.push(`Indicaciones del docente: ${material.instructions}`);
    }
    if (material.fixedQuestions.length) {
      extra.push(
        'Incluye TEXTUALMENTE estas preguntas (cuentan dentro del total) y genera sus puntos clave:\n' +
          material.fixedQuestions.map((q) => `- ${q}`).join('\n'),
      );
    }

    const prompt = `Genera exactamente ${n} preguntas abiertas en ${language} sobre el siguiente contenido (${scope}).

Reglas:
- Cubre temas distintos del contenido, no repitas ideas.
- ${DIFFICULTY_HINT[material.difficulty] || DIFFICULTY_HINT.mixed}
- Cada pregunta debe poder responderse en 1 a 3 frases por WhatsApp. Nada de preguntas de sí/no ni de opción múltiple.
- No menciones "la transcripción", "el video" ni minutos; pregunta por los conceptos.
- Para cada pregunta incluye los puntos clave que una respuesta correcta debe contener.
${extra.length ? '\n' + extra.join('\n\n') + '\n' : ''}
Responde SOLO con JSON: [{"question": "...", "key_points": ["...", "..."]}]

CONTENIDO DE REFERENCIA:
${material.content}`;

    const raw = await this.gemini.generateJson<
      { question?: string; key_points?: string[] }[]
    >(
      'Eres un evaluador académico. Generas preguntas para verificar si un estudiante comprendió el contenido de un curso. Usa EXCLUSIVAMENTE el contenido de referencia; no inventes temas.',
      prompt,
      0.5,
    );

    return (Array.isArray(raw) ? raw : [])
      .filter((q) => q?.question)
      .slice(0, n)
      .map((q) => ({
        question: String(q.question).trim(),
        key_points: (q.key_points || []).map(String),
        answer: null,
        score: null,
        feedback: null,
        clarifications: 0,
        answered_at: null,
      }));
  }

  // ─── Calificación ──────────────────────────────────────────────────────

  private async handleAnswer(session: Session, text: string): Promise<string> {
    const idx = session.current_question;
    const total = session.questions.length;
    const q = session.questions[idx];

    let grade: {
      is_answer?: boolean | string;
      score?: number;
      feedback?: string;
    };
    try {
      grade = await this.gemini.generateJson(
        'Eres un tutor que califica respuestas de estudiantes por WhatsApp con criterio justo y amable. Acepta como correcta cualquier respuesta equivalente aunque use otras palabras o no sea exhaustiva.',
        `Pregunta: ${q.question}
Puntos clave esperados: ${q.key_points.join('; ') || '(no especificados)'}

Mensaje del estudiante: "${text.replace(/"/g, "'").slice(0, 2000)}"

Determina primero si el mensaje es un intento de responder (incluye "no sé") o si es una duda/pedido de aclaración sobre la pregunta.
- Si es un intento de respuesta: califícalo de 0 a 100 según cuántos puntos clave cubre y si hay errores conceptuales. En "feedback" (máximo 3 frases) di qué estuvo bien y complementa lo que faltó o corrige el error.
- Si es una duda: no califiques; en "feedback" aclara la pregunta sin revelar la respuesta.

Responde SOLO con JSON: {"is_answer": true, "score": 0, "feedback": "..."}`,
        0.1,
      );
    } catch (error) {
      this.logger.error(
        `Error calificando session=${session._id}: ${(error as Error).message}`,
      );
      return 'Tuve un problema revisando tu respuesta. ¿Puedes enviarla de nuevo?';
    }

    const feedback = String(grade.feedback || '').trim();
    const isAnswer =
      typeof grade.is_answer === 'string'
        ? !['false', 'no', '0'].includes(grade.is_answer.trim().toLowerCase())
        : grade.is_answer !== false;

    // Duda sobre la pregunta: aclarar y volver a preguntar (máx. 2 por pregunta)
    if (!isAnswer && (q.clarifications || 0) < 2) {
      await this.sessionModel
        .updateOne(
          { _id: session._id },
          { $inc: { [`questions.${idx}.clarifications`]: 1 } },
        )
        .exec();
      return `${feedback}\n\n*Pregunta ${idx + 1}/${total}:* ${q.question}`;
    }

    const score = Math.max(
      0,
      Math.min(100, Math.round(Number(grade.score) || 0)),
    );
    const answered: AiEvaluationQuestion = {
      ...q,
      answer: text,
      score,
      feedback,
      answered_at: new Date(),
    };
    session.questions[idx] = answered;
    await this.update(session, {
      [`questions.${idx}`]: answered,
      current_question: idx + 1,
    });

    const passing = session.passing_score ?? 70;
    const icon = score >= passing ? '✅' : score >= 40 ? '🟡' : '❌';
    const reply = `${icon} ${feedback}`;
    if (idx + 1 < total) {
      const nextQ = session.questions[idx + 1];
      return `${reply}\n\n*Pregunta ${idx + 2}/${total}:* ${nextQ.question}`;
    }
    return `${reply}\n\n${await this.finish(session)}`;
  }

  // ─── Cierre ────────────────────────────────────────────────────────────

  private async finish(session: Session): Promise<string> {
    const questions = session.questions;
    const passing = session.passing_score ?? 70;
    const score = Math.round(
      questions.reduce((sum, q) => sum + (q.score || 0), 0) / questions.length,
    );
    const passed = score >= passing;
    const scope = session.module_name || 'el curso';

    let summary: {
      summary?: string;
      strengths?: string[];
      improvements?: string[];
      recommendation?: string;
    } = {};
    try {
      const qa = questions
        .map(
          (q, i) =>
            `${i + 1}. P: ${q.question}\n   R: ${q.answer}\n   Puntaje: ${q.score}/100 — ${q.feedback}`,
        )
        .join('\n');
      summary = await this.gemini.generateJson(
        'Eres un tutor académico que da retroalimentación final, concreta y motivadora.',
        `El estudiante ${session.user_name || ''} terminó una evaluación de ${scope} del curso "${session.event_name}" con un puntaje de ${score}/100.

Preguntas, respuestas y calificaciones:
${qa}

Responde SOLO con JSON:
{"summary": "2-3 frases sobre su desempeño general",
 "strengths": ["fortaleza concreta", "..."],
 "improvements": ["tema concreto a reforzar", "..."],
 "recommendation": "1-2 frases sobre qué repasar del curso a continuación"}`,
        0.3,
      );
    } catch (error) {
      this.logger.error(
        `Error generando resumen session=${session._id}: ${(error as Error).message}`,
      );
    }

    const result = await this.resultModel.create({
      session_id: session._id,
      user_id: session.user_id,
      user_name: session.user_name,
      phone: session.phone,
      event_id: session.event_id,
      event_name: session.event_name,
      organization_id: session.organization_id,
      module_id: session.module_id,
      module_name: session.module_name,
      score,
      passed,
      passing_score: passing,
      total_questions: questions.length,
      correct_answers: questions.filter((q) => (q.score || 0) >= passing)
        .length,
      questions: questions.map((q) => ({
        question: q.question,
        key_points: q.key_points,
        answer: q.answer,
        score: q.score,
        feedback: q.feedback,
      })),
      summary: summary.summary || '',
      strengths: summary.strengths || [],
      improvements: summary.improvements || [],
      recommendation: summary.recommendation || '',
      started_at: session.started_at,
    });
    await this.update(session, {
      status: 'completed',
      result_id: result._id,
      score,
      finished_at: new Date(),
    });

    const lines = [
      '🎓 *Evaluación finalizada*',
      `${session.event_name} — ${scope}`,
      `Puntaje: *${score}/100* · ${passed ? 'Aprobada ✅' : 'No aprobada'}`,
    ];
    if (result.summary) lines.push('', result.summary);
    if (result.strengths.length) {
      lines.push('', '*Fortalezas:*', ...result.strengths.map((s) => `• ${s}`));
    }
    if (result.improvements.length) {
      lines.push(
        '',
        '*Para reforzar:*',
        ...result.improvements.map((s) => `• ${s}`),
      );
    }
    if (result.recommendation) lines.push('', result.recommendation);
    lines.push('', 'Puedes volver a evaluarte desde el curso cuando quieras.');
    return lines.join('\n');
  }
}
