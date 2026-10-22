import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  EngagementKind,
  EngagementMessage,
  EngagementStatus,
} from './schemas/engagement-message.schema';
import { ProgressEvent } from 'src/progress-events/schemas/progress-event.schema';
import { Event } from 'src/events/schemas/event.schema';
import { OrganizationUser } from 'src/organization-users/schemas/organization-user.schema';
import { User } from 'src/users/schemas/user.schema';
import { UserActivityDay } from 'src/user-activity/schemas/user-activity-day.schema';
import { PracticeSession } from 'src/ai-evaluations/schemas/practice-session.schema';
import { resolveEmail, resolveName } from 'src/reminders/contact.util';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Colombia no tiene horario de verano: el día local empieza a las 05:00 UTC
const LOCAL_OFFSET = '-05:00';
const MAX_MESSAGES = 20000;
// Por debajo de esto, en cualquiera de los dos grupos, la diferencia contra
// el grupo de control no es confiable
export const MIN_SAMPLE = 30;
const PRACTICE_KINDS: EngagementKind[] = ['practice_review', 'practice_invite'];

export const DEFAULT_WINDOW_HOURS = 72;

export interface ReportFilter {
  from?: string; // YYYY-MM-DD local
  to?: string; // YYYY-MM-DD local, inclusive
  kind?: EngagementKind;
  windowHours?: number;
}

/** Resultado de un envío: qué hizo el estudiante después. */
export interface Outcome {
  /** Ya pasó la ventana completa: entra en las tasas */
  matured: boolean;
  /** Usó la plataforma (o avanzó) dentro de la ventana */
  returned_at: Date | null;
  progressed_at: Date | null;
  completed_at: Date | null;
}

export interface PracticeOutcome {
  status: string;
  started_at: Date | null;
  score: number | null;
}

/** Diferencia de tasas (tratados - control) con intervalo de confianza 95 %. */
export interface Lift {
  /** Puntos porcentuales */
  value: number | null;
  ci_low: number | null;
  ci_high: number | null;
  /** El intervalo no incluye 0 */
  significant: boolean | null;
}

export interface KindSummary {
  kind: EngagementKind | 'all';
  /** Gen.ON: paso ("1.1") y segmento; null en los demás tipos */
  step: string | null;
  segment: string | null;
  /** Gen.ON en simulación: habrían salido */
  planned: number;
  total: number;
  sent: number;
  fallback_email: number;
  failed: number;
  capped: number;
  holdout: number;
  /** sent + fallback_email */
  delivered: number;

  // Estados de Meta (solo envíos por WhatsApp con wamid)
  with_status: number;
  meta_delivered: number;
  meta_read: number;
  meta_failed: number;
  delivery_rate: number | null;
  read_rate: number | null;

  // Interacción con el mensaje (solo WhatsApp)
  replied: number;
  reply_rate: number | null;
  /** Envíos cuyo enlace llevaba ?ref= */
  click_tracked: number;
  clicked: number;
  click_rate: number | null;
  opted_out: number;

  // Qué hizo después (entregados con la ventana ya cumplida)
  matured: number;
  returned: number;
  return_rate: number | null;
  progressed: number;
  progress_rate: number | null;
  completed: number;
  completion_rate: number | null;

  // Grupo de control
  holdout_matured: number;
  holdout_returned: number;
  holdout_return_rate: number | null;
  holdout_progressed: number;
  holdout_progress_rate: number | null;
  return_lift: Lift;
  /** Avance: el resultado principal */
  lift: Lift;
  /** Algún grupo tiene menos de MIN_SAMPLE envíos con la ventana cumplida */
  small_sample: boolean;

  // Simulacros (null si el tipo no es de simulacro)
  practice_started: number | null;
  practice_completed: number | null;
  practice_start_rate: number | null;
  practice_avg_score: number | null;
}

const rate = (num: number, den: number) =>
  den > 0 ? Math.round((num / den) * 1000) / 10 : null;

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Diferencia de proporciones con intervalo de Wald al 95 %. Es una
 * aproximación: con muestras chicas (small_sample) el intervalo no es fiable.
 */
export function liftOf(
  treated: number,
  treatedN: number,
  control: number,
  controlN: number,
): Lift {
  if (!treatedN || !controlN) {
    return { value: null, ci_low: null, ci_high: null, significant: null };
  }
  const p1 = treated / treatedN;
  const p2 = control / controlN;
  const diff = p1 - p2;
  const se = Math.sqrt((p1 * (1 - p1)) / treatedN + (p2 * (1 - p2)) / controlN);
  const low = (diff - 1.96 * se) * 100;
  const high = (diff + 1.96 * se) * 100;
  return {
    value: round1(diff * 100),
    ci_low: round1(low),
    ci_high: round1(high),
    significant: low > 0 || high < 0,
  };
}

const DELIVERED: EngagementStatus[] = ['sent', 'fallback_email'];

type MessageDoc = {
  _id: unknown;
  kind: EngagementKind;
  step?: string | null;
  segment?: string | null;
  status: string;
  user_id: string;
  at: Date;
  dedupe_key?: string | null;
  replied_at?: Date | null;
  opted_out_at?: Date | null;
  wamid?: string | null;
  meta_status?: string | null;
  delivered_at?: Date | null;
  read_at?: Date | null;
  clicked_at?: Date | null;
  click_tracked?: boolean;
};

/**
 * Embudo de los mensajes de la plataforma: entregado (Meta) → leído →
 * clic / respuesta → volvió a la plataforma → avanzó, comparado con el grupo
 * de control (holdout), que cumplió las mismas condiciones pero no recibió
 * el mensaje.
 *
 * - "Volvió": usó la plataforma en la organización (user_activity_days) o
 *   avanzó, dentro de `windowHours` después del envío.
 * - "Avanzó": registro en progress_events (actividad o curso) en cursos de
 *   la organización dentro de la ventana.
 */
@Injectable()
export class EngagementReportService {
  constructor(
    @InjectModel(EngagementMessage.name)
    private readonly messageModel: Model<EngagementMessage>,
    @InjectModel(ProgressEvent.name)
    private readonly progressEventModel: Model<ProgressEvent>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(OrganizationUser.name)
    private readonly organizationUserModel: Model<OrganizationUser>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(UserActivityDay.name)
    private readonly activityDayModel: Model<UserActivityDay>,
    @InjectModel(PracticeSession.name)
    private readonly practiceSessionModel: Model<PracticeSession>,
  ) {}

  async summary(organizationId: string, filter: ReportFilter) {
    const windowHours = this.windowHours(filter);
    const { messages, outcomes, practice, range } = await this.load(
      organizationId,
      filter,
      windowHours,
    );

    // Los toques de Gen.ON se agrupan por paso (1.1, 1.2…), no por tipo
    const groups = new Map<string, MessageDoc[]>();
    for (const m of messages) {
      const key = m.step ? `${m.kind}:${m.step}` : m.kind;
      const list = groups.get(key) || [];
      list.push(m);
      groups.set(key, list);
    }

    return {
      from: range.from,
      to: range.to,
      window_hours: windowHours,
      min_sample: MIN_SAMPLE,
      truncated: messages.length >= MAX_MESSAGES,
      totals: this.summarize('all', messages, outcomes, practice),
      kinds: Array.from(groups.values())
        .map((list) => this.summarize(list[0].kind, list, outcomes, practice))
        .sort((a, b) =>
          a.step && b.step
            ? a.step.localeCompare(b.step, undefined, { numeric: true })
            : b.total - a.total,
        ),
    };
  }

  /** Detalle por envío (los más recientes primero), con nombre y resultado. */
  async messages(
    organizationId: string,
    filter: ReportFilter & { status?: EngagementStatus; limit?: number },
  ) {
    const windowHours = this.windowHours(filter);
    const limit = Math.min(Math.max(filter.limit || 200, 1), 1000);
    const { messages, outcomes, practice } = await this.load(
      organizationId,
      filter,
      windowHours,
      { status: filter.status, limit },
    );

    const names = await this.resolveNames(
      organizationId,
      messages.map((m) => m.user_id),
    );
    return messages.map((m: any) => {
      const id = String(m._id);
      const outcome = outcomes.get(id);
      const contact = names.get(m.user_id);
      return {
        _id: id,
        kind: m.kind,
        step: m.step ?? null,
        segment: m.segment ?? null,
        status: m.status,
        at: m.at,
        user_id: m.user_id,
        name: contact?.name || '',
        email: contact?.email || '',
        event_id: m.event_id,
        template: m.template,
        error: m.error,
        meta_status: m.meta_status ?? null,
        delivered_at: m.delivered_at ?? null,
        read_at: m.read_at ?? null,
        meta_error: m.meta_error ?? null,
        click_tracked: Boolean(m.click_tracked),
        clicked_at: m.clicked_at ?? null,
        replied_at: m.replied_at,
        reply_text: m.reply_text,
        opted_out_at: m.opted_out_at,
        matured: outcome?.matured ?? false,
        returned_at: outcome?.returned_at ?? null,
        progressed_at: outcome?.progressed_at ?? null,
        completed_at: outcome?.completed_at ?? null,
        practice: practice.get(id) ?? null,
      };
    });
  }

  // ───────────────────────── Cálculo ─────────────────────────

  private windowHours(filter: ReportFilter): number {
    const w = Number(filter.windowHours);
    return Number.isFinite(w) && w >= 1 && w <= 24 * 60
      ? w
      : DEFAULT_WINDOW_HOURS;
  }

  private async load(
    organizationId: string,
    filter: ReportFilter,
    windowHours: number,
    options: { status?: EngagementStatus; limit?: number } = {},
  ) {
    const now = Date.now();
    const toDate = filter.to || this.localDate(new Date(now));
    const fromDate =
      filter.from || this.localDate(new Date(now - 30 * DAY_MS));
    const start = new Date(`${fromDate}T00:00:00${LOCAL_OFFSET}`);
    const end = new Date(
      new Date(`${toDate}T00:00:00${LOCAL_OFFSET}`).getTime() + DAY_MS,
    );

    const query: Record<string, any> = {
      organization_id: organizationId,
      at: { $gte: start, $lt: end },
    };
    if (filter.kind) query.kind = filter.kind;
    if (options.status) query.status = options.status;

    const messages = (await this.messageModel
      .find(query)
      .sort({ at: -1 })
      .limit(options.limit || MAX_MESSAGES)
      .lean()
      .exec()) as unknown as MessageDoc[];

    const [outcomes, practice] = await Promise.all([
      this.computeOutcomes(organizationId, messages, windowHours, now),
      this.practiceOutcomes(messages),
    ]);
    return {
      messages,
      outcomes,
      practice,
      range: { from: fromDate, to: toDate },
    };
  }

  /**
   * Para cada envío entregado (y cada registro del grupo de control): si
   * volvió a la plataforma, el primer avance y la primera finalización de
   * curso dentro de la ventana.
   */
  private async computeOutcomes(
    organizationId: string,
    messages: MessageDoc[],
    windowHours: number,
    now: number,
  ): Promise<Map<string, Outcome>> {
    const outcomes = new Map<string, Outcome>();
    const tracked = messages.filter(
      (m) =>
        DELIVERED.includes(m.status as EngagementStatus) ||
        m.status === 'holdout',
    );
    if (!tracked.length) return outcomes;

    const windowMs = windowHours * HOUR_MS;
    const minAt = Math.min(...tracked.map((m) => new Date(m.at).getTime()));
    const maxAt = Math.max(...tracked.map((m) => new Date(m.at).getTime()));
    const userIds = Array.from(new Set(tracked.map((m) => String(m.user_id))));
    const eventIds = await this.organizationEventIds(organizationId);

    const [events, days] = await Promise.all([
      eventIds.length
        ? this.progressEventModel.collection
            .find(
              {
                user_id: { $in: userIds },
                event_id: { $in: eventIds },
                at: { $gt: new Date(minAt), $lte: new Date(maxAt + windowMs) },
              },
              { projection: { user_id: 1, type: 1, at: 1 } },
            )
            .sort({ at: 1 })
            .toArray()
        : Promise.resolve([] as any[]),
      this.activityDayModel.collection
        .find(
          {
            user_id: { $in: userIds },
            organization_id: organizationId,
            last_at: { $gt: new Date(minAt) },
            first_at: { $lte: new Date(maxAt + windowMs) },
          },
          { projection: { user_id: 1, first_at: 1, last_at: 1 } },
        )
        .sort({ first_at: 1 })
        .toArray(),
    ]);

    const eventsByUser = new Map<string, { type: string; at: Date }[]>();
    for (const e of events as any[]) {
      const list = eventsByUser.get(String(e.user_id)) || [];
      list.push({ type: e.type, at: new Date(e.at) });
      eventsByUser.set(String(e.user_id), list);
    }
    const daysByUser = new Map<string, { first: Date; last: Date }[]>();
    for (const d of days as any[]) {
      const list = daysByUser.get(String(d.user_id)) || [];
      list.push({ first: new Date(d.first_at), last: new Date(d.last_at) });
      daysByUser.set(String(d.user_id), list);
    }

    for (const m of tracked) {
      const sentAt = new Date(m.at).getTime();
      const until = sentAt + windowMs;
      let progressedAt: Date | null = null;
      let completedAt: Date | null = null;
      for (const e of eventsByUser.get(String(m.user_id)) || []) {
        const t = e.at.getTime();
        if (t <= sentAt) continue;
        if (t > until) break;
        if (!progressedAt) progressedAt = e.at;
        if (!completedAt && e.type === 'course_completed') completedAt = e.at;
      }

      // Primer día con uso después del envío. Solo se conoce la primera y
      // la última hora del día: si empezó antes del envío y siguió después,
      // se toma la última (cota segura de que volvió).
      let visitedAt: Date | null = null;
      for (const d of daysByUser.get(String(m.user_id)) || []) {
        if (d.last.getTime() <= sentAt || d.first.getTime() > until) continue;
        const t =
          d.first.getTime() > sentAt
            ? d.first
            : new Date(Math.min(d.last.getTime(), until));
        if (!visitedAt || t < visitedAt) visitedAt = t;
      }
      const returnedAt =
        [visitedAt, progressedAt]
          .filter((d): d is Date => Boolean(d))
          .sort((a, b) => a.getTime() - b.getTime())[0] || null;

      outcomes.set(String(m._id), {
        matured: until <= now,
        returned_at: returnedAt,
        progressed_at: progressedAt,
        completed_at: completedAt,
      });
    }
    return outcomes;
  }

  /** Estado del simulacro de cada invitación (dedupe_key "practice:<id>"). */
  private async practiceOutcomes(
    messages: MessageDoc[],
  ): Promise<Map<string, PracticeOutcome>> {
    const out = new Map<string, PracticeOutcome>();
    const sessionByMessage = new Map<string, string>();
    for (const m of messages) {
      if (!PRACTICE_KINDS.includes(m.kind)) continue;
      const sessionId = String(m.dedupe_key || '').replace(/^practice:/, '');
      if (Types.ObjectId.isValid(sessionId)) {
        sessionByMessage.set(String(m._id), sessionId);
      }
    }
    if (!sessionByMessage.size) return out;

    const sessions = await this.practiceSessionModel.collection
      .find(
        {
          _id: {
            $in: Array.from(new Set(sessionByMessage.values())).map(
              (id) => new Types.ObjectId(id),
            ),
          },
        },
        { projection: { status: 1, started_at: 1, score: 1 } },
      )
      .toArray();
    const byId = new Map(sessions.map((s: any) => [String(s._id), s]));
    for (const [messageId, sessionId] of sessionByMessage) {
      const s: any = byId.get(sessionId);
      if (!s) continue;
      out.set(messageId, {
        status: s.status,
        started_at: s.started_at || null,
        score: typeof s.score === 'number' ? s.score : null,
      });
    }
    return out;
  }

  private summarize(
    kind: EngagementKind | 'all',
    messages: MessageDoc[],
    outcomes: Map<string, Outcome>,
    practice: Map<string, PracticeOutcome>,
  ): KindSummary {
    const count = (status: EngagementStatus) =>
      messages.filter((m) => m.status === status).length;
    const delivered = messages.filter((m) =>
      DELIVERED.includes(m.status as EngagementStatus),
    );
    const viaWhatsapp = delivered.filter((m) => m.status === 'sent');
    const withStatus = viaWhatsapp.filter((m) => m.wamid);
    const replied = viaWhatsapp.filter((m) => m.replied_at).length;
    const clickTracked = viaWhatsapp.filter((m) => m.click_tracked);
    const clicked = clickTracked.filter((m) => m.clicked_at).length;
    const metaDelivered = withStatus.filter(
      (m) => m.delivered_at || m.read_at,
    ).length;
    const metaRead = withStatus.filter((m) => m.read_at).length;
    const metaFailed = withStatus.filter(
      (m) => m.meta_status === 'failed',
    ).length;

    const maturedOf = (list: MessageDoc[]) =>
      list
        .map((m) => outcomes.get(String(m._id)))
        .filter((o): o is Outcome => Boolean(o?.matured));
    const matured = maturedOf(delivered);
    const returned = matured.filter((o) => o.returned_at).length;
    const progressed = matured.filter((o) => o.progressed_at).length;
    const completed = matured.filter((o) => o.completed_at).length;
    const holdoutMatured = maturedOf(
      messages.filter((m) => m.status === 'holdout'),
    );
    const holdoutReturned = holdoutMatured.filter((o) => o.returned_at).length;
    const holdoutProgressed = holdoutMatured.filter(
      (o) => o.progressed_at,
    ).length;

    const practiceRows = delivered.filter((m) => PRACTICE_KINDS.includes(m.kind));
    const practiceOutcomes = practiceRows
      .map((m) => practice.get(String(m._id)))
      .filter((p): p is PracticeOutcome => Boolean(p));
    const practiceStarted = practiceOutcomes.filter((p) => p.started_at).length;
    const completedPractice = practiceOutcomes.filter(
      (p) => p.status === 'completed',
    );
    const scores = completedPractice
      .map((p) => p.score)
      .filter((s): s is number => s !== null);
    const hasPractice = practiceRows.length > 0;

    const first = messages[0];
    return {
      kind,
      step: kind === 'all' ? null : (first?.step ?? null),
      segment: kind === 'all' ? null : (first?.segment ?? null),
      planned: count('planned'),
      total: messages.length,
      sent: count('sent'),
      fallback_email: count('fallback_email'),
      failed: count('failed'),
      capped: count('capped'),
      holdout: count('holdout'),
      delivered: delivered.length,

      with_status: withStatus.length,
      meta_delivered: metaDelivered,
      meta_read: metaRead,
      meta_failed: metaFailed,
      delivery_rate: rate(metaDelivered, withStatus.length),
      read_rate: rate(metaRead, withStatus.length),

      replied,
      reply_rate: rate(replied, viaWhatsapp.length),
      click_tracked: clickTracked.length,
      clicked,
      click_rate: rate(clicked, clickTracked.length),
      opted_out: messages.filter((m) => m.opted_out_at).length,

      matured: matured.length,
      returned,
      return_rate: rate(returned, matured.length),
      progressed,
      progress_rate: rate(progressed, matured.length),
      completed,
      completion_rate: rate(completed, matured.length),

      holdout_matured: holdoutMatured.length,
      holdout_returned: holdoutReturned,
      holdout_return_rate: rate(holdoutReturned, holdoutMatured.length),
      holdout_progressed: holdoutProgressed,
      holdout_progress_rate: rate(holdoutProgressed, holdoutMatured.length),
      return_lift: liftOf(
        returned,
        matured.length,
        holdoutReturned,
        holdoutMatured.length,
      ),
      lift: liftOf(
        progressed,
        matured.length,
        holdoutProgressed,
        holdoutMatured.length,
      ),
      small_sample:
        matured.length < MIN_SAMPLE || holdoutMatured.length < MIN_SAMPLE,

      practice_started: hasPractice ? practiceStarted : null,
      practice_completed: hasPractice ? completedPractice.length : null,
      practice_start_rate: hasPractice
        ? rate(practiceStarted, practiceRows.length)
        : null,
      practice_avg_score: scores.length
        ? round1(scores.reduce((a, b) => a + b, 0) / scores.length)
        : null,
    };
  }

  private async organizationEventIds(organizationId: string): Promise<string[]> {
    const vals: any[] = [organizationId];
    if (Types.ObjectId.isValid(organizationId)) {
      vals.push(new Types.ObjectId(organizationId));
    }
    const events = await this.eventModel.collection
      .find({ organizer_id: { $in: vals } }, { projection: { _id: 1 } })
      .toArray();
    return events.map((e: any) => String(e._id));
  }

  private async resolveNames(organizationId: string, userIds: string[]) {
    const unique = Array.from(new Set(userIds.map(String)));
    const out = new Map<string, { name: string; email: string }>();
    if (!unique.length) return out;

    const objectIds = unique
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    const orgVals: any[] = [organizationId];
    if (Types.ObjectId.isValid(organizationId)) {
      orgVals.push(new Types.ObjectId(organizationId));
    }
    const [orgUsers, users] = await Promise.all([
      this.organizationUserModel.collection
        .find(
          {
            organization_id: { $in: orgVals },
            user_id: { $in: [...unique, ...objectIds] },
          },
          { projection: { user_id: 1, properties: 1 } },
        )
        .toArray(),
      this.userModel.collection
        .find({ _id: { $in: objectIds } }, { projection: { names: 1, email: 1 } })
        .toArray(),
    ]);
    const orgUserById = new Map(orgUsers.map((o: any) => [String(o.user_id), o]));
    const userById = new Map(users.map((u: any) => [String(u._id), u]));
    for (const id of unique) {
      const orgUser: any = orgUserById.get(id) || null;
      const user = userById.get(id) || null;
      out.set(id, {
        name: resolveName(orgUser, user),
        email: resolveEmail(orgUser, user) || '',
      });
    }
    return out;
  }

  private localDate(d: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
    }).format(d);
  }
}
