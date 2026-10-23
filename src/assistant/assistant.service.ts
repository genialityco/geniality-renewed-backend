import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Organization } from 'src/organizations/schemas/organization.schema';
import { WhatsappOptOutService } from 'src/engagement/whatsapp-opt-out.service';
import { phoneTail } from 'src/engagement/engagement-log.service';
import { WhatsappInboundService } from 'src/ai-evaluations/whatsapp-inbound.service';
import { normalizeText } from 'src/ai-evaluations/practice-format';
import { OutboundMessage } from 'src/reminders/whatsapp-gateway.client';
import {
  AssistantConversation,
  AssistantOrgOption,
  AssistantTurn,
} from './schemas/assistant-conversation.schema';
import { GeminiChatClient } from './gemini-chat.client';
import { ASSISTANT_TOOLS, AssistantToolsService } from './assistant-tools.service';
import { AuthLinksService } from 'src/auth-links/auth-links.service';

const TIME_ZONE = 'America/Bogota';
export const DEFAULT_DAILY_LIMIT = 30;
// La conversación recuerda los turnos de esta ventana
const MEMORY_MS = 30 * 60 * 1000;
const MEMORY_TURNS = 10;
const MAX_REPLY_CHARS = 3500;
const CHOICE_PREFIX = 'as:org:';
const SWITCH_WORDS = new Set([
  'organizacion',
  'cambiar organizacion',
  'cambiar de organizacion',
]);

interface EnabledMembership extends AssistantOrgOption {
  personName: string;
  instructions: string;
  dailyLimit: number;
  /** Los enlaces de las respuestas entran con la sesión iniciada */
  autoLogin: boolean;
}

const localDate = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(date);

/**
 * Asistente por WhatsApp: responde lo que ningún otro motor atendió, solo a
 * miembros de organizaciones con el asistente habilitado. Usa herramientas
 * de solo lectura atadas a la persona (sus cursos, avance, exámenes y el
 * contenido de los videos). Si el número no es de un miembro, no responde
 * (el número de WhatsApp también se usa para otras cosas).
 */
@Injectable()
export class AssistantService implements OnModuleInit {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    @InjectModel(AssistantConversation.name)
    private readonly conversationModel: Model<AssistantConversation>,
    @InjectModel(Organization.name)
    private readonly organizationModel: Model<Organization>,
    private readonly optOut: WhatsappOptOutService,
    private readonly inbound: WhatsappInboundService,
    private readonly gemini: GeminiChatClient,
    private readonly tools: AssistantToolsService,
    private readonly authLinks?: AuthLinksService,
  ) {}

  onModuleInit() {
    // La elección de organización (botón) se atiende antes que los simulacros
    this.inbound.registerHandler({
      name: 'assistant-choice',
      matches: async (_phone, _text, replyId) => Boolean(replyId?.startsWith(CHOICE_PREFIX)),
      handle: (phone, text, replyId) => this.reply(phone, text, replyId),
    });
    // Texto libre que nadie más atendió (no botones de otros flujos)
    this.inbound.registerFallback({
      name: 'assistant',
      matches: async (_phone, text, replyId) => !replyId && Boolean(text?.trim()),
      handle: (phone, text, replyId) => this.reply(phone, text, replyId),
    });
  }

  async reply(
    phone: string,
    text: string,
    replyId?: string,
  ): Promise<OutboundMessage[] | null> {
    const options = await this.enabledMemberships(phone);
    if (!options.length) return null;
    const tail = phoneTail(phone)!;
    const conv = await this.conversationModel
      .findOneAndUpdate(
        { phone_tail: tail },
        { $setOnInsert: { phone_tail: tail, phone } },
        { upsert: true, new: true },
      )
      .exec();

    let question = String(text || '').trim();
    let current = options.find((o) => o.organization_id === conv.organization_id) || null;

    // Eligió organización con el botón
    if (replyId?.startsWith(CHOICE_PREFIX)) {
      const chosen = options.find((o) => o.organization_id === replyId.slice(CHOICE_PREFIX.length));
      if (!chosen) return ['Esa organización ya no tiene el asistente disponible.'];
      current = chosen;
      await this.conversationModel
        .updateOne(
          { _id: conv._id },
          {
            $set: {
              organization_id: chosen.organization_id,
              user_id: chosen.user_id,
              choosing: null,
              pending_question: null,
            },
          },
        )
        .exec();
      if (!conv.pending_question) {
        return [`Listo, te ayudo con *${chosen.name}*. ¿Qué necesitas?`];
      }
      question = conv.pending_question;
    } else if (options.length > 1 && SWITCH_WORDS.has(normalizeText(question))) {
      return [await this.askOrganization(conv, options, null)];
    } else if (!current) {
      if (options.length === 1) current = options[0];
      else return [await this.askOrganization(conv, options, question)];
    }

    // Tope diario por persona
    const today = localDate(new Date());
    const count = conv.day === today ? conv.day_count : 0;
    if (count > current.dailyLimit) return null;
    if (count === current.dailyLimit) {
      await this.conversationModel
        .updateOne({ _id: conv._id }, { $set: { day: today, day_count: count + 1 } })
        .exec();
      return [
        'Por hoy llegaste al límite de mensajes con el asistente. Mañana puedes seguir preguntando. 🙌',
      ];
    }

    const history = (conv.turns || [])
      .filter(
        (t) =>
          t.organization_id === current!.organization_id &&
          Date.now() - new Date(t.at).getTime() < MEMORY_MS,
      )
      .slice(-MEMORY_TURNS)
      .map((t) => ({ role: t.role === 'user' ? ('user' as const) : ('model' as const), text: t.text }));

    const scope = { userId: current.user_id, organizationId: current.organization_id };
    let answer: string;
    let calls: AssistantTurn['tools'] = [];
    try {
      const enrolled = await this.tools.enrollments(scope);
      const result = await this.gemini.chat({
        system: this.systemPrompt(current, enrolled.map((e) => e.course.name)),
        history,
        message: question,
        tools: ASSISTANT_TOOLS,
        runTool: (name, args) => this.tools.run(scope, name, args),
      });
      calls = result.calls;
      answer =
        result.text ||
        'No encontré cómo responder eso. ¿Puedes escribir tu pregunta de otra forma?';
    } catch (error) {
      this.logger.error(
        `Asistente: no se pudo responder a ${tail}: ${(error as Error).message}`,
      );
      answer = 'Tuve un problema para responder. Intenta de nuevo en un momento, por favor.';
    }
    if (answer.length > MAX_REPLY_CHARS) answer = `${answer.slice(0, MAX_REPLY_CHARS)}…`;

    const now = new Date();
    const turns: AssistantTurn[] = [
      { role: 'user', text: question.slice(0, 2000), at: now, organization_id: current.organization_id },
      {
        role: 'assistant',
        text: answer,
        at: new Date(),
        organization_id: current.organization_id,
        tools: calls,
      },
    ];
    await this.conversationModel
      .updateOne(
        { _id: conv._id },
        {
          $set: {
            organization_id: current.organization_id,
            user_id: current.user_id,
            choosing: null,
            pending_question: null,
            day: today,
            day_count: count + 1,
            last_at: now,
          },
          $push: { turns: { $each: turns, $slice: -200 } },
        },
      )
      .exec();
    // La conversación guardada (que vuelve a Gemini como historial) queda sin
    // el token; solo el mensaje que sale lleva el acceso directo
    if (!current.autoLogin || !this.authLinks) return [answer];
    return this.authLinks.addToMessages(
      [answer],
      current.user_id,
      current.organization_id,
      'assistant',
    );
  }

  /** Membresías del número en organizaciones con el asistente habilitado. */
  private async enabledMemberships(phone: string): Promise<EnabledMembership[]> {
    const memberships = await this.optOut.membershipsByPhone(phone);
    if (!memberships.length) return [];
    const orgIds = [...new Set(memberships.map((m) => m.organization_id))].filter((id) =>
      Types.ObjectId.isValid(id),
    );
    const orgs = await this.organizationModel.collection
      .find(
        { _id: { $in: orgIds.map((id) => new Types.ObjectId(id)) }, 'assistant.enabled': true },
        { projection: { name: 1, assistant: 1 } },
      )
      .toArray();
    const orgById = new Map(orgs.map((o: any) => [String(o._id), o]));
    const out: EnabledMembership[] = [];
    for (const m of memberships) {
      const org: any = orgById.get(m.organization_id);
      if (!org || out.some((o) => o.organization_id === m.organization_id)) continue;
      const props = m.properties || {};
      out.push({
        organization_id: m.organization_id,
        user_id: m.user_id,
        name: String(org.name || 'tu organización'),
        personName: String(props.nombres || props.names || '').trim().split(/\s+/)[0] || '',
        instructions: String(org.assistant?.instructions || '').trim(),
        dailyLimit: Number(org.assistant?.daily_limit) > 0 ? Number(org.assistant.daily_limit) : DEFAULT_DAILY_LIMIT,
        autoLogin: org.assistant?.auto_login_links !== false,
      });
    }
    return out;
  }

  /** Pregunta de qué organización quiere hablar (lista de WhatsApp). */
  private async askOrganization(
    conv: AssistantConversation,
    options: EnabledMembership[],
    question: string | null,
  ): Promise<OutboundMessage> {
    const choosing = options.slice(0, 10).map((o) => ({
      organization_id: o.organization_id,
      user_id: o.user_id,
      name: o.name,
    }));
    await this.conversationModel
      .updateOne(
        { _id: conv._id },
        { $set: { choosing, pending_question: question || null } },
      )
      .exec();
    return {
      body: 'Perteneces a varias organizaciones. ¿Sobre cuál quieres hablar?',
      footer: 'Para cambiar después, escribe ORGANIZACIÓN',
      list: {
        button: 'Elegir',
        sections: [
          {
            rows: choosing.map((o) => ({
              id: `${CHOICE_PREFIX}${o.organization_id}`,
              title: o.name.slice(0, 24),
              description: o.name.length > 24 ? o.name.slice(0, 72) : undefined,
            })),
          },
        ],
      },
    };
  }

  private systemPrompt(m: EnabledMembership, courses: string[]): string {
    const today = new Intl.DateTimeFormat('es-CO', {
      timeZone: TIME_ZONE,
      dateStyle: 'full',
    }).format(new Date());
    return [
      `Eres el asistente académico de ${m.name} por WhatsApp. Hablas con ${m.personName || 'un miembro de la organización'}, profesional de la salud inscrito en la plataforma. Hoy es ${today}.`,
      courses.length
        ? `Está inscrito en: ${courses.join('; ')}.`
        : 'No está inscrito en ningún curso de esta organización.',
      'Ayudas con: sus cursos y su avance, qué le falta (actividades, exámenes, certificado), dónde está un tema en los videos y dudas sobre el contenido de los cursos.',
      'Reglas:',
      '- Usa las herramientas para cualquier dato de la persona o de los cursos. No inventes datos, notas, fechas ni enlaces: los enlaces salen solo de las herramientas.',
      '- Para dudas de contenido, usa buscar_contenido y responde con base en los fragmentos; menciona la actividad y comparte el enlace al minuto del video. Si el tema no está en los cursos, dilo; puedes dar una orientación general breve aclarando que no viene del curso.',
      '- No des indicaciones clínicas sobre pacientes concretos (diagnóstico, dosis o tratamiento de un caso real): sugiere consultar las guías o a un especialista.',
      '- Solo tienes datos de esta persona. Nunca hables de otros usuarios ni compartas sus datos.',
      '- Para pagos, acceso a la cuenta o fallas técnicas, sugiere contactar al soporte de la organización.',
      '- Responde en español, breve (hasta unas 120 palabras), con formato de WhatsApp: *negrita* con un asterisco y listas con "•". Sin tablas ni títulos con #.',
      m.instructions ? `Indicaciones de ${m.name}:\n${m.instructions.slice(0, 2000)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
}
