import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { UsersService } from 'src/users/users.service';
import { Event } from 'src/events/schemas/event.schema';
import { Activity } from 'src/activities/schemas/activity.schema';
import {
  CaseExpectedItem,
  CaseOption,
  CaseResponseType,
  CaseStage,
  ClinicalCase,
} from './schemas/clinical-case.schema';
import {
  CaseItemStatus,
  CaseReview,
  ClinicalCaseSession,
} from './schemas/clinical-case-session.schema';
import { GeminiTextClient } from './gemini-text.client';
import { ActivityQuestionsService } from './activity-questions.service';
import { CourseContentService, idVariants } from './course-content.service';
import {
  ClinicalCaseEngineService,
  stageHadErrors,
} from './clinical-case-engine.service';
import {
  activeExpected,
  initialStageProgress,
  stageMisses,
} from './clinical-case-policy';
import { ClinicalCaseResourcesService } from './clinical-case-resources.service';
import { shuffleArray } from './practice-format';

const DEFAULT_STAGES = 4;
const MIN_STAGES = 2;
const MAX_STAGES = 6;
const DEFAULT_MAX_TURNS = 4;
const MIN_MATERIAL_CHARS = 400;
// Seguimiento a largo plazo
const DEFAULT_FOLLOWUP_YEARS = 5;
const MAX_FOLLOWUP_YEARS = 10;
const DEFAULT_FOLLOWUP_STAGES = 3;
const MAX_FOLLOWUP_STAGES = 5;

export interface GenerateCaseBody {
  activity_id?: string | null;
  num_stages?: number;
  instructions?: string;
}

export type CaseInput = Partial<
  Pick<
    ClinicalCase,
    | 'title'
    | 'summary'
    | 'presentation'
    | 'stages'
    | 'followup_stages'
    | 'followup_horizon'
    | 'enabled'
    | 'reviewed'
    | 'reviewed_by'
  >
>;

export interface ReviewSessionBody {
  // Estado que fija el docente para cada paso revisado
  items?: { stage: number; item_id: string; status: CaseItemStatus }[];
  // Riesgos / imprecisiones mal detectados (texto exacto)
  dismiss_unsafe?: string[];
  dismiss_unnecessary?: string[];
  note?: string;
}

export interface GenerateFollowupBody {
  years?: number;
  num_stages?: number;
  instructions?: string;
}

const newId = () => randomBytes(4).toString('hex');
const str = (v: unknown) => String(v ?? '').trim();
const strings = (v: unknown) =>
  Array.isArray(v) ? v.map(str).filter(Boolean) : [];

/**
 * Casos clínicos del agente socrático: generación con IA a partir del
 * contenido del curso o de una actividad, edición en el admin y flujo del
 * estudiante (iniciar/retomar, conversar, ver resultado).
 */
@Injectable()
export class ClinicalCasesService {
  private readonly logger = new Logger(ClinicalCasesService.name);
  // Sesiones procesando un turno (evita respuestas dobles por doble envío)
  private readonly busy = new Set<string>();

  constructor(
    @InjectModel(ClinicalCase.name)
    private readonly caseModel: Model<ClinicalCase>,
    @InjectModel(ClinicalCaseSession.name)
    private readonly sessionModel: Model<ClinicalCaseSession>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Activity.name)
    private readonly activityModel: Model<Activity>,
    private readonly usersService: UsersService,
    private readonly gemini: GeminiTextClient,
    private readonly activityQuestions: ActivityQuestionsService,
    private readonly courseContent: CourseContentService,
    private readonly engine: ClinicalCaseEngineService,
    private readonly resources: ClinicalCaseResourcesService,
  ) {}

  // ─── Admin ─────────────────────────────────────────────────────────────

  async list(organizationId: string, eventId: string) {
    await this.event(organizationId, eventId);
    const cases = await this.caseModel
      .find({ event_id: new Types.ObjectId(eventId) })
      .sort({ created_at: -1 })
      .lean()
      .exec();
    const counts = await this.sessionModel
      .aggregate<{ _id: Types.ObjectId; total: number; completed: number }>([
        { $match: { case_id: { $in: cases.map((c) => c._id) } } },
        {
          $group: {
            _id: '$case_id',
            total: { $sum: 1 },
            completed: {
              $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
            },
          },
        },
      ])
      .exec();
    const byCase = new Map(counts.map((c) => [String(c._id), c]));
    return cases.map((c) => ({
      ...c,
      sessions: byCase.get(String(c._id))?.total || 0,
      completed_sessions: byCase.get(String(c._id))?.completed || 0,
    }));
  }

  async get(organizationId: string, caseId: string) {
    return this.caseDoc(organizationId, caseId);
  }

  /** Genera un caso con IA (queda deshabilitado para que el admin lo revise). */
  async generate(
    organizationId: string,
    eventId: string,
    uid: string,
    body: GenerateCaseBody,
  ) {
    const event = await this.event(organizationId, eventId);
    let material = '';
    let activity: Activity | null = null;
    if (body.activity_id) {
      if (!Types.ObjectId.isValid(body.activity_id)) {
        throw new BadRequestException('Actividad inválida');
      }
      activity = await this.activityModel
        .findOne({
          _id: new Types.ObjectId(body.activity_id),
          event_id: { $in: idVariants(eventId) },
        })
        .exec();
      if (!activity) throw new NotFoundException('Actividad no encontrada');
      material = (await this.activityQuestions.buildMaterial(event, activity))
        .text;
    } else {
      material = (await this.courseContent.getMaterial(event, null)).content;
    }
    if (material.length < MIN_MATERIAL_CHARS) {
      throw new BadRequestException(
        'No hay contenido suficiente para generar un caso: agrega la transcripción de los videos o documentos a la actividad/curso.',
      );
    }

    const numStages = Math.min(
      MAX_STAGES,
      Math.max(
        MIN_STAGES,
        Math.round(Number(body.num_stages) || DEFAULT_STAGES),
      ),
    );
    const instructions = str(body.instructions).slice(0, 2000);

    const prompt = `MATERIAL DEL CURSO:
${material}

${instructions ? `INSTRUCCIONES DEL ADMINISTRADOR: ${instructions}\n` : ''}
Diseña UN caso clínico realista, coherente con el material, dividido en ${numStages} etapas de la enfermedad (p. ej. consulta inicial, confirmación diagnóstica, tratamiento inicial, complicación/seguimiento).

Reglas:
- "presentation": paciente concreto (edad, sexo, motivo de consulta, antecedentes, signos vitales y examen físico relevantes). No reveles el diagnóstico.
- "summary": 1 frase para el estudiante que NO revele el diagnóstico (ej. "Mujer de 54 años con fatiga y poliuria").
- Cada etapa: "title" (para el docente), "reveal" (información nueva que aparece al llegar a esa etapa: evolución, resultados de laboratorio, respuesta al tratamiento; en la primera etapa puede ir vacío), "question" (qué debe decidir el estudiante, abierta, p. ej. "¿Cuál es tu impresión diagnóstica y qué estudios solicitarías?"), "expected" (2 a 5 pasos esperados) y "common_errors" (errores frecuentes).
- Cada paso esperado: "text" concreto y verificable (máx. 15 palabras), "category" "diagnosis" (hipótesis o diagnóstico) o "action" (estudio, conducta, tratamiento, derivación, educación), "critical" true solo para lo indispensable (1-2 por etapa) y "rationale" (por qué, 1 frase).
- La PRIMERA etapa evalúa la impresión diagnóstica: incluye al menos un paso con "category": "diagnosis" (el diagnóstico o la hipótesis principal). Si esa etapa es de opción única, su paso esperado es el diagnóstico y los distractores son diagnósticos diferenciales plausibles.
- "response_type" de cada etapa, según lo que se evalúa (mezcla los tipos a lo largo del caso):
  · "single_choice": hay UNA decisión correcta entre alternativas plausibles (p. ej. el diagnóstico más probable entre diferenciales). Un solo paso esperado.
  · "multiple_choice": hay VARIAS acciones correctas entre otras plausibles pero inadecuadas (p. ej. qué estudios pedir). 2-4 pasos esperados.
  · "open": razonamiento o plan que conviene expresar con sus palabras (p. ej. justificar el manejo, educación al paciente).
- En etapas de selección, "options": 4 a 6 opciones. Las correctas indican "expected_index" (posición del paso esperado que cubren, desde 0); los distractores llevan "expected_index": null, "why_not" (por qué no es adecuado aquí) y "unsafe": true si pondrían en riesgo al paciente. Distractores plausibles, del mismo tipo y longitud que las correctas. En etapas "open", "options": [].
- Usa dosis, valores y criterios del material cuando existan.

Responde SOLO con JSON: {"title":"","summary":"","presentation":"","stages":[{"title":"","reveal":"","question":"","response_type":"single_choice","options":[{"text":"","expected_index":0,"why_not":"","unsafe":false}],"expected":[{"text":"","category":"diagnosis","critical":true,"rationale":""}],"common_errors":[]}]}`;
    const hasDiagnosis = (stages: CaseStage[]) =>
      stages.some((st) => st.expected.some((i) => i.category === 'diagnosis'));

    let content: {
      title: string;
      summary: string;
      presentation: string;
      stages: CaseStage[];
      followup_stages: CaseStage[];
      followup_horizon: string;
    } | null = null;
    // Si la IA no incluye un paso de diagnóstico, se reintenta una vez
    for (let attempt = 0; attempt < 2 && !content; attempt++) {
      let raw: Record<string, any>;
      try {
        raw = await this.gemini.generateJson<Record<string, any>>(
          'Eres un médico docente experto en diseñar casos clínicos para evaluar el razonamiento de estudiantes de ciencias de la salud. Escribes en español, con rigor clínico, basándote en el material del curso.',
          attempt
            ? `${prompt}\n\nIMPORTANTE: en tu respuesta anterior ningún paso tenía "category": "diagnosis". La primera etapa DEBE tener el diagnóstico como paso "diagnosis".`
            : prompt,
          0.5,
          120000,
        );
      } catch (error) {
        this.logger.error(
          `Generación de caso falló: ${(error as Error).message}`,
        );
        throw new BadRequestException(
          'No se pudo generar el caso con IA. Intenta de nuevo en un momento.',
        );
      }
      const normalized = this.normalize(raw);
      if (hasDiagnosis(normalized.stages) || attempt === 1) {
        if (!hasDiagnosis(normalized.stages)) {
          this.logger.warn('Caso generado sin paso de diagnóstico');
        }
        content = normalized;
      }
    }
    if (!content) throw new BadRequestException('No se pudo generar el caso');

    // La IA tiende a poner las correctas primero
    for (const stage of content.stages)
      stage.options = shuffleArray(stage.options);
    // "Dónde estudiarlo": actividad + minuto de cada paso esperado
    await this.resources
      .fillStages(content.stages, eventId)
      .catch((error) =>
        this.logger.warn(`Recursos del caso: ${(error as Error).message}`),
      );
    const user = await this.usersService.findByFirebaseUid(uid);
    return this.caseModel.create({
      ...content,
      organization_id: new Types.ObjectId(organizationId),
      event_id: new Types.ObjectId(eventId),
      activity_id: activity ? (activity._id as Types.ObjectId) : null,
      enabled: false,
      source: 'ai',
      reviewed: false,
      created_by: user._id,
      updated_by: user._id,
    });
  }

  async update(
    organizationId: string,
    caseId: string,
    uid: string,
    body: CaseInput,
  ) {
    const doc = await this.caseDoc(organizationId, caseId);
    const content = this.normalize({
      title: body.title ?? doc.title,
      summary: body.summary ?? doc.summary,
      presentation: body.presentation ?? doc.presentation,
      stages: body.stages ?? doc.stages,
      followup_stages: body.followup_stages ?? doc.followup_stages,
      followup_horizon: body.followup_horizon ?? doc.followup_horizon,
    });
    // Pasos nuevos o reescritos sin recursos: se buscan; si el admin quitó
    // los de un paso sin cambiar su texto, se respeta
    const previous = new Map(
      [...doc.stages, ...(doc.followup_stages || [])]
        .flatMap((s) => s.expected)
        .map((i) => [i.id, i.text]),
    );
    const needsResources = (item: CaseExpectedItem) =>
      !item.resources?.length && previous.get(item.id) !== item.text;
    await this.resources
      .fillStages(
        [...content.stages, ...content.followup_stages],
        doc.event_id,
        needsResources,
      )
      .catch((error) =>
        this.logger.warn(`Recursos del caso: ${(error as Error).message}`),
      );
    const user = await this.usersService.findByFirebaseUid(uid);
    Object.assign(doc, content, {
      updated_by: user._id,
      ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
      ...(body.reviewed !== undefined
        ? { reviewed: Boolean(body.reviewed) }
        : {}),
      ...(body.reviewed_by !== undefined
        ? { reviewed_by: str(body.reviewed_by).slice(0, 200) }
        : {}),
    });
    doc.markModified('stages');
    doc.markModified('followup_stages');
    await doc.save();
    return doc;
  }

  /**
   * Genera con IA la parte 2 (seguimiento a largo plazo) de un caso: controles
   * en el tiempo, consecuencias de omitir cada paso (también de la parte
   * aguda) y pasos condicionales que solo aplican si algo se omitió.
   * Reemplaza el seguimiento anterior; el caso queda para revisión.
   */
  async generateFollowup(
    organizationId: string,
    caseId: string,
    uid: string,
    body: GenerateFollowupBody,
  ) {
    const doc = await this.caseDoc(organizationId, caseId);
    const event = await this.event(organizationId, String(doc.event_id));
    const material = await this.material(
      event,
      doc.activity_id ? String(doc.activity_id) : null,
    );
    const years = Math.min(
      MAX_FOLLOWUP_YEARS,
      Math.max(1, Math.round(Number(body.years) || DEFAULT_FOLLOWUP_YEARS)),
    );
    const numStages = Math.min(
      MAX_FOLLOWUP_STAGES,
      Math.max(
        MIN_STAGES,
        Math.round(Number(body.num_stages) || DEFAULT_FOLLOWUP_STAGES),
      ),
    );
    const instructions = str(body.instructions).slice(0, 2000);
    const acute = doc.stages
      .map(
        (s, i) =>
          `Etapa ${i + 1} (${s.title}): ${s.question}\n${s.expected
            .map((e) => `  - id "${e.id}": ${e.text}`)
            .join('\n')}`,
      )
      .join('\n');

    let raw: Record<string, any>;
    try {
      raw = await this.gemini.generateJson<Record<string, any>>(
        'Eres un médico docente experto en enfermedades crónicas. Diseñas el seguimiento a largo plazo de un caso clínico para evaluar el razonamiento de estudiantes, en español, con rigor clínico y basado en el material del curso.',
        `MATERIAL DEL CURSO:
${material}

CASO (parte aguda, ya diseñada):
Título: ${doc.title}
Paciente: ${doc.presentation}
${acute}

${instructions ? `INSTRUCCIONES DEL ADMINISTRADOR: ${instructions}\n` : ''}
Diseña el SEGUIMIENTO A LARGO PLAZO de este mismo paciente durante ${years} año${years === 1 ? '' : 's'}, en ${numStages} controles (etapas) ordenados en el tiempo.

Reglas:
- "horizon": texto corto del horizonte (ej. "${years} años").
- "acute_if_missed": para los pasos de la parte aguda cuya omisión tendría consecuencias a largo plazo, qué le pasaría al paciente (1-2 frases concretas, en pasado o presente, como un hallazgo del control). Usa sus ids.
- Cada etapa: "time_label" (ej. "3 meses después", "1 año después", "${years} años después"), "title" (para el docente), "reveal" (evolución esperable del paciente con el manejo: síntomas, adherencia, laboratorios, efectos adversos), "question" (qué decide en ese control), "response_type" y "options" (igual que en la parte aguda: mezcla "open", "single_choice" y "multiple_choice"; en selección 4-6 opciones, correctas con "expected_index", distractores con "expected_index": null, "why_not" y "unsafe"), "expected" (2-5 pasos) y "common_errors".
- Cada paso esperado: "text", "category" ("diagnosis" o "action"), "critical", "rationale" e "if_missed": qué le pasa al paciente en el SIGUIENTE control si el estudiante no lo plantea (vacío en el último control si no aplica).
- Pasos condicionales: si un paso solo tiene sentido porque antes se omitió otro (ej. "Referir a oftalmología" porque no se pidió el tamizaje de retinopatía), pon "only_if_missed" con el id del paso de la parte aguda o "f<etapa>.<paso>" (posiciones desde 0) de un paso de un control ANTERIOR; si no, null. Una etapa con pasos condicionales debe ser "open" y tener también pasos sin condición.
- Los controles deben reflejar que una enfermedad crónica requiere varias intervenciones: metas, ajuste del tratamiento, adherencia, tamizaje y manejo de complicaciones, efectos adversos y educación.
- Usa dosis, metas y criterios del material cuando existan.

Responde SOLO con JSON: {"horizon":"","acute_if_missed":[{"id":"","if_missed":""}],"stages":[{"time_label":"","title":"","reveal":"","question":"","response_type":"open","options":[],"expected":[{"text":"","category":"action","critical":true,"rationale":"","if_missed":"","only_if_missed":null}],"common_errors":[]}]}`,
        0.5,
        150000,
      );
    } catch (error) {
      this.logger.error(
        `Generación del seguimiento falló: ${(error as Error).message}`,
      );
      throw new BadRequestException(
        'No se pudo generar el seguimiento con IA. Intenta de nuevo en un momento.',
      );
    }

    const acuteIds = new Set(
      doc.stages.flatMap((s) => s.expected.map((i) => i.id)),
    );
    const followup = this.normalizeStages(raw?.stages, {
      followup: true,
      known: acuteIds,
    });
    if (!followup.length) {
      throw new BadRequestException(
        'La IA no devolvió un seguimiento válido. Intenta de nuevo.',
      );
    }
    for (const stage of followup) stage.options = shuffleArray(stage.options);

    // Consecuencias a largo plazo de omitir pasos de la parte aguda
    const acuteConsequences = new Map<string, string>(
      (Array.isArray(raw?.acute_if_missed) ? raw.acute_if_missed : [])
        .map((x: any): [string, string] => [
          str(x?.id),
          str(x?.if_missed).slice(0, 600),
        ])
        .filter(([id, text]: [string, string]) => acuteIds.has(id) && text),
    );
    for (const stage of doc.stages) {
      for (const item of stage.expected) {
        const text = acuteConsequences.get(item.id);
        if (text) item.if_missed = text;
      }
    }

    await this.resources
      .fillStages(followup, doc.event_id)
      .catch((error) =>
        this.logger.warn(
          `Recursos del seguimiento: ${(error as Error).message}`,
        ),
      );
    const user = await this.usersService.findByFirebaseUid(uid);
    doc.followup_stages = followup;
    doc.followup_horizon =
      str(raw?.horizon).slice(0, 60) || `${years} año${years === 1 ? '' : 's'}`;
    doc.updated_by = user._id as Types.ObjectId;
    doc.markModified('stages');
    doc.markModified('followup_stages');
    await doc.save();
    return doc;
  }

  /** Vuelve a buscar en los videos del curso los recursos de todos los pasos. */
  async refreshResources(organizationId: string, caseId: string) {
    const doc = await this.caseDoc(organizationId, caseId);
    await this.resources.fillStages(doc.stages, doc.event_id, () => true);
    doc.markModified('stages');
    await doc.save();
    return doc;
  }

  async remove(organizationId: string, caseId: string) {
    const doc = await this.caseDoc(organizationId, caseId);
    await doc.deleteOne();
    return { deleted: true };
  }

  /** Intentos de los estudiantes en un caso (resumen). */
  async caseSessions(organizationId: string, caseId: string) {
    const doc = await this.caseDoc(organizationId, caseId);
    const sessions = await this.sessionModel
      .find({ case_id: doc._id })
      .select(
        'user_name email part status current_stage scores started_at finished_at messages.role case_snapshot.stages.id review.reviewed_at',
      )
      .sort({ created_at: -1 })
      .limit(200)
      .lean()
      .exec();
    return sessions.map((s) => ({
      _id: s._id,
      user_name: s.user_name,
      email: s.email,
      status: s.status,
      part: s.part || 'acute',
      reviewed: Boolean(s.review),
      stage: s.current_stage + 1,
      total_stages: s.case_snapshot?.stages?.length || 0,
      turns: s.messages.filter((m) => m.role === 'student').length,
      scores: s.scores,
      started_at: s.started_at,
      finished_at: s.finished_at,
    }));
  }

  /**
   * Revisión de un docente sobre un intento terminado: fija el estado de los
   * pasos (lo planteó / a medias / no) y descarta riesgos o imprecisiones mal
   * detectados. Recalcula la nota y guarda cada cambio como dato de
   * calibración del evaluador.
   */
  async reviewSession(
    organizationId: string,
    sessionId: string,
    uid: string,
    body: ReviewSessionBody,
  ) {
    const session = await this.sessionModel
      .findOne({
        _id: this.objectId(sessionId),
        organization_id: new Types.ObjectId(organizationId),
      })
      .exec();
    if (!session) throw new NotFoundException('Intento no encontrado');
    if (session.status !== 'completed') {
      throw new BadRequestException('Solo se revisan intentos terminados');
    }
    const reviewer = await this.usersService.findByFirebaseUid(uid);
    const stages = session.case_snapshot.stages;
    const changes: CaseReview['changes'] = [];
    const statuses: CaseItemStatus[] = ['missing', 'partial', 'covered'];

    let checked = 0;
    for (const entry of body.items || []) {
      const s = Number(entry?.stage);
      const progress = session.stages[s];
      const item = stages[s]?.expected.find((i) => i.id === entry?.item_id);
      const p = progress?.items.find((x) => x.item_id === entry?.item_id);
      if (!item || !p || p.active === false) continue;
      if (!statuses.includes(entry.status)) continue;
      checked++;
      p.reviewed = true;
      if (p.status === entry.status) continue;
      changes.push({
        stage: s,
        kind: 'item',
        item_id: item.id,
        text: item.text,
        from: p.status,
        to: entry.status,
        evidence: p.evidence || '',
      });
      p.status = entry.status;
      // El docente lo da por logrado sin ayuda, salvo que ya hubiera pista
      p.hint_level = entry.status === 'missing' ? null : (p.hint_level ?? 0);
    }

    const dismiss = (
      kind: 'unsafe' | 'unnecessary',
      texts: string[] | undefined,
    ) => {
      const remove = new Set((texts || []).map((t) => String(t)));
      if (!remove.size) return;
      session.stages.forEach((progress, s) => {
        const list = progress[kind] || [];
        const kept = list.filter((t) => !remove.has(t));
        for (const t of list.filter((t) => remove.has(t))) {
          changes.push({
            stage: s,
            kind,
            text: t,
            from: 'detectado',
            to: 'descartado',
          });
        }
        progress[kind] = kept;
      });
    };
    dismiss('unsafe', body.dismiss_unsafe);
    dismiss('unnecessary', body.dismiss_unnecessary);

    const previous = session.review;
    session.review = {
      reviewer_id: reviewer._id as Types.ObjectId,
      reviewer_name: (reviewer as any).names || (reviewer as any).email || '',
      reviewed_at: new Date(),
      note: str(body.note).slice(0, 2000),
      items_checked: Math.max(checked, previous?.items_checked || 0),
      changes: [...(previous?.changes || []), ...changes],
    };
    this.engine.refreshAfterReview(session);
    session.markModified('stages');
    session.markModified('scores');
    session.markModified('feedback');
    session.markModified('messages');
    session.markModified('review');
    await session.save();
    return session.toObject();
  }

  /**
   * Calibración del evaluador en un caso: cuántos intentos revisó un docente,
   * cuántos pasos corrigió y la concordancia IA–docente.
   */
  async calibration(organizationId: string, caseId: string) {
    const doc = await this.caseDoc(organizationId, caseId);
    const reviewed = await this.sessionModel
      .find({ case_id: doc._id, review: { $ne: null } })
      .select('user_name email review')
      .sort({ 'review.reviewed_at': -1 })
      .lean()
      .exec();
    let checked = 0;
    let itemChanges = 0;
    let falsePositive = 0; // la IA dio crédito y el docente no
    let falseNegative = 0; // la IA no dio crédito y el docente sí
    let dismissedUnsafe = 0;
    let dismissedUnnecessary = 0;
    for (const s of reviewed) {
      const review = s.review as CaseReview;
      checked += review.items_checked || 0;
      for (const c of review.changes || []) {
        if (c.kind === 'unsafe') dismissedUnsafe++;
        else if (c.kind === 'unnecessary') dismissedUnnecessary++;
        else {
          itemChanges++;
          const rank = { missing: 0, partial: 1, covered: 2 } as Record<
            string,
            number
          >;
          if (rank[c.to] < rank[c.from]) falsePositive++;
          else falseNegative++;
        }
      }
    }
    return {
      reviewed_sessions: reviewed.length,
      items_checked: checked,
      item_changes: itemChanges,
      // % de pasos revisados en los que el docente coincidió con la IA
      agreement: checked
        ? Math.round(((checked - itemChanges) / checked) * 100)
        : null,
      false_positive: falsePositive,
      false_negative: falseNegative,
      dismissed_unsafe: dismissedUnsafe,
      dismissed_unnecessary: dismissedUnnecessary,
      changes: reviewed.flatMap((s) =>
        ((s.review as CaseReview).changes || []).map((c) => ({
          ...c,
          session_id: String(s._id),
          student: s.user_name || s.email,
        })),
      ),
    };
  }

  /** Detalle completo de un intento para el admin (incluye la evaluación oculta). */
  async adminSession(organizationId: string, sessionId: string) {
    const session = await this.sessionModel
      .findOne({
        _id: this.objectId(sessionId),
        organization_id: new Types.ObjectId(organizationId),
      })
      .lean()
      .exec();
    if (!session) throw new NotFoundException('Intento no encontrado');
    return session;
  }

  // ─── Estudiante ────────────────────────────────────────────────────────

  /**
   * Casos habilitados del curso + el último intento del estudiante en cada
   * uno, y el estado del seguimiento a largo plazo si el caso lo tiene.
   */
  async available(uid: string, organizationId: string, eventId: string) {
    await this.event(organizationId, eventId);
    const user = await this.usersService.findByFirebaseUid(uid);
    const cases = await this.caseModel
      .find({ event_id: new Types.ObjectId(eventId), enabled: true })
      .select(
        'title summary stages.id activity_id followup_stages.id followup_horizon',
      )
      .sort({ created_at: 1 })
      .lean()
      .exec();
    const sessions = await this.sessionModel
      .find({
        user_id: { $in: idVariants(user._id) },
        case_id: { $in: cases.map((c) => c._id) },
      })
      .select('case_id part status scores created_at current_stage')
      .sort({ created_at: -1 })
      .lean()
      .exec();
    const summary = (s?: (typeof sessions)[number]) =>
      s
        ? {
            _id: String(s._id),
            status: s.status,
            stage: s.current_stage + 1,
            scores: s.scores,
          }
        : null;
    return cases.map((c) => {
      const mine = sessions.filter((s) => String(s.case_id) === String(c._id));
      const acute = mine.filter((s) => s.part !== 'followup');
      const followup = mine.find((s) => s.part === 'followup');
      const hasFollowup = Boolean(c.followup_stages?.length);
      return {
        _id: String(c._id),
        title: c.title,
        summary: c.summary,
        total_stages: c.stages.length,
        last_session: summary(acute[0]),
        followup: hasFollowup
          ? {
              horizon: c.followup_horizon || '',
              total_stages: c.followup_stages.length,
              // Se desbloquea al terminar la parte aguda
              unlocked: acute.some((s) => s.status === 'completed'),
              last_session: summary(followup),
            }
          : null,
      };
    });
  }

  /** Retoma el intento en curso o crea uno nuevo (parte aguda o seguimiento). */
  async start(
    uid: string,
    organizationId: string,
    caseId: string,
    part: 'acute' | 'followup' = 'acute',
  ) {
    const doc = await this.caseDoc(organizationId, caseId);
    if (!doc.enabled)
      throw new ForbiddenException('Este caso no está disponible');
    const user = await this.usersService.findByFirebaseUid(uid);

    const active = await this.sessionModel
      .findOne({
        user_id: { $in: idVariants(user._id) },
        case_id: doc._id,
        part: part === 'followup' ? 'followup' : { $ne: 'followup' },
        status: 'in_progress',
      })
      .exec();
    if (active) return this.view(active);

    const base = {
      user_id: user._id,
      user_name: (user as any).names || '',
      email: (user as any).email || '',
      organization_id: doc.organization_id,
      event_id: doc.event_id,
      case_id: doc._id,
      channel: 'web',
      status: 'in_progress',
      current_stage: 0,
      started_at: new Date(),
    };

    let session: ClinicalCaseSession;
    if (part === 'followup') {
      if (!doc.followup_stages?.length) {
        throw new BadRequestException(
          'Este caso no tiene seguimiento a largo plazo',
        );
      }
      // Parte del último intento terminado de la parte aguda
      const parent = await this.sessionModel
        .findOne({
          user_id: { $in: idVariants(user._id) },
          case_id: doc._id,
          part: { $ne: 'followup' },
          status: 'completed',
        })
        .sort({ finished_at: -1 })
        .exec();
      if (!parent) {
        throw new BadRequestException(
          'Primero resuelve la parte aguda del caso para hacer su seguimiento.',
        );
      }
      // Intentos anteriores a esta función no guardaban lo omitido
      const missed = parent.missed_item_ids?.length
        ? parent.missed_item_ids
        : parent.case_snapshot.stages.flatMap((stage, i) =>
            parent.stages[i]
              ? stageMisses(stage, parent.stages[i]).map((x) => x.id)
              : [],
          );
      // Consecuencias de lo omitido en la parte aguda (texto vigente del caso)
      const ifMissed = new Map(
        [...doc.stages, ...parent.case_snapshot.stages]
          .flatMap((s) => s.expected)
          .filter((i) => i.if_missed?.trim())
          .map((i) => [i.id, String(i.if_missed).trim()] as [string, string]),
      );
      session = new this.sessionModel({
        ...base,
        part: 'followup',
        parent_session_id: parent._id,
        case_snapshot: {
          title: doc.title,
          presentation: doc.presentation,
          stages: doc.followup_stages,
          followup_horizon: doc.followup_horizon,
        },
        stages: doc.followup_stages.map(initialStageProgress),
        missed_item_ids: missed,
        pending_consequences: missed
          .filter((id) => ifMissed.has(id))
          .map((id) => ({ item_id: id, text: ifMissed.get(id) })),
      });
    } else {
      session = new this.sessionModel({
        ...base,
        part: 'acute',
        case_snapshot: {
          title: doc.title,
          presentation: doc.presentation,
          stages: doc.stages,
        },
        stages: doc.stages.map(initialStageProgress),
      });
    }
    this.engine.open(session);
    await session.save();
    return this.view(session);
  }

  async getMine(uid: string, organizationId: string, sessionId: string) {
    return this.view(await this.mySession(uid, organizationId, sessionId));
  }

  async message(
    uid: string,
    organizationId: string,
    sessionId: string,
    text: string,
    selected: string[] = [],
  ) {
    if (!str(text) && !selected.length) {
      throw new BadRequestException('Escribe tu respuesta');
    }
    const session = await this.mySession(uid, organizationId, sessionId);
    if (session.status !== 'in_progress') {
      throw new BadRequestException('Este caso ya terminó');
    }
    const key = String(session._id);
    if (this.busy.has(key)) {
      throw new ConflictException('Espera la respuesta del tutor');
    }
    this.busy.add(key);
    try {
      await this.engine.reply(session, text, selected);
      session.markModified('stages');
      session.markModified('messages');
      session.markModified('scores');
      session.markModified('feedback');
      session.markModified('case_snapshot');
      await session.save();
      return this.view(session);
    } finally {
      this.busy.delete(key);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /**
   * Lo que ve el estudiante: la conversación y "etapa X de N". Los pasos
   * esperados solo aparecen al terminar, con su resultado.
   */
  private async view(session: ClinicalCaseSession) {
    const snapshot = session.case_snapshot;
    const done = session.status === 'completed';
    const part = session.part || 'acute';
    // Al terminar la parte aguda se ofrece el seguimiento, si el caso lo tiene
    const followupAvailable =
      done && part === 'acute'
        ? Boolean(
            await this.caseModel
              .exists({
                _id: session.case_id,
                enabled: true,
                'followup_stages.0': { $exists: true },
              })
              .exec(),
          )
        : false;
    return {
      session_id: String(session._id),
      case_id: String(session.case_id),
      title: snapshot.title,
      part,
      reviewed: Boolean(session.review),
      review_note: session.review?.note || '',
      followup_horizon: snapshot.followup_horizon || '',
      followup_available: followupAvailable,
      status: session.status,
      stage: session.current_stage + 1,
      total_stages: snapshot.stages.length,
      choice: (() => {
        const current = snapshot.stages[session.current_stage];
        if (
          done ||
          !current ||
          current.response_type === undefined ||
          current.response_type === 'open' ||
          !current.options?.length
        ) {
          return null;
        }
        return {
          type: current.response_type,
          options: current.options.map((o) => ({ id: o.id, text: o.text })),
        };
      })(),
      messages: session.messages.map((m) => ({
        role: m.role,
        content: m.content,
        created_at: m.created_at,
        ...(m.kind === 'summary'
          ? { kind: m.kind, feedback: session.feedback }
          : {}),
      })),
      result: done
        ? {
            scores: session.scores,
            feedback: session.feedback,
            stages: snapshot.stages.map((stage, s) => ({
              title: stage.title,
              time_label: stage.time_label || '',
              question: stage.question,
              items: (session.stages[s]
                ? activeExpected(stage, session.stages[s])
                : stage.expected
              ).map((item) => {
                const p = session.stages[s]?.items.find(
                  (x) => x.item_id === item.id,
                );
                return {
                  text: item.text,
                  category: item.category,
                  critical: item.critical,
                  rationale: item.rationale,
                  resources: item.resources || [],
                  status: p?.status || 'missing',
                  // Con pista, o indispensable de una etapa con errores
                  with_help:
                    Boolean(p?.hint_level) ||
                    (item.critical && stageHadErrors(session.stages[s])),
                };
              }),
            })),
          }
        : null,
    };
  }

  /** Valida y normaliza un caso (IA o admin); asigna ids a etapas e ítems. */
  private normalize(input: Record<string, any>) {
    const title = str(input.title).slice(0, 200);
    const presentation = str(input.presentation).slice(0, 6000);
    if (!title) throw new BadRequestException('El caso necesita un título');
    if (!presentation) {
      throw new BadRequestException(
        'El caso necesita la presentación del paciente',
      );
    }
    const stages = this.normalizeStages(input.stages, {
      followup: false,
      known: new Set(),
    });
    if (!stages.length) {
      throw new BadRequestException(
        'El caso necesita al menos una etapa con pregunta y pasos esperados',
      );
    }
    const acuteIds = new Set(
      stages.flatMap((s) => s.expected.map((i) => i.id)),
    );
    return {
      title,
      summary: str(input.summary).slice(0, 300),
      presentation,
      stages,
      followup_stages: this.normalizeStages(input.followup_stages, {
        followup: true,
        known: acuteIds,
      }),
      followup_horizon: str(input.followup_horizon).slice(0, 60),
    };
  }

  /**
   * Normaliza etapas. En el seguimiento admite el momento del control y pasos
   * condicionales: "only_if_missed" debe apuntar a un paso ANTERIOR (de la
   * parte aguda o de un control previo), por id o, desde la IA, como
   * "f<etapa>.<paso>".
   */
  private normalizeStages(
    raw: unknown,
    opts: { followup: boolean; known: Set<string> },
  ): CaseStage[] {
    const rawStages = Array.isArray(raw) ? raw : [];
    const known = new Set(opts.known);
    const aiRefs = new Map<string, string>();
    const stages: CaseStage[] = [];

    rawStages.forEach((s: any, sIdx: number) => {
      const expected: CaseExpectedItem[] = [];
      (Array.isArray(s?.expected) ? s.expected : []).forEach(
        (i: any, iIdx: number) => {
          const text = str(i?.text).slice(0, 300);
          if (!text) return;
          const id = str(i?.id) || newId();
          aiRefs.set(`f${sIdx}.${iIdx}`, id);
          let condition: string | null = str(i?.only_if_missed) || null;
          if (condition && aiRefs.has(condition) && !known.has(condition)) {
            condition = aiRefs.get(condition) as string;
          }
          if (!opts.followup || (condition && !known.has(condition))) {
            condition = null;
          }
          expected.push({
            id,
            text,
            category: i?.category === 'diagnosis' ? 'diagnosis' : 'action',
            critical: i?.critical === true || String(i?.critical) === 'true',
            rationale: str(i?.rationale).slice(0, 600),
            resources: (Array.isArray(i?.resources) ? i.resources : [])
              .map((r: any) => ({
                activity_id: str(r?.activity_id),
                activity_name: str(r?.activity_name).slice(0, 200),
                start_time: Math.max(0, Math.floor(Number(r?.start_time) || 0)),
              }))
              .filter((r: { activity_id: string }) =>
                Types.ObjectId.isValid(r.activity_id),
              )
              .slice(0, 3),
            if_missed: str(i?.if_missed).slice(0, 600),
            only_if_missed: condition,
          });
        },
      );
      const question = str(s?.question).slice(0, 600);
      if (!question || !expected.length) return;

      // Siempre algún paso sin condición (si no, la etapa podría quedar vacía)
      if (expected.every((i) => i.only_if_missed)) {
        expected[0].only_if_missed = null;
      }
      // Un crítico entre los incondicionales, para poder avanzar por dominio
      const unconditional = expected.filter((i) => !i.only_if_missed);
      if (!unconditional.some((i) => i.critical)) {
        unconditional[0].critical = true;
      }
      // Con condicionales, la etapa es abierta: las opciones no dependen de la historia
      let { responseType, options } = this.normalizeOptions(s, expected);
      if (expected.some((i) => i.only_if_missed)) {
        responseType = 'open';
        options = [];
      }
      const maxTurns = Math.round(Number(s?.max_turns));
      stages.push({
        id: str(s?.id) || newId(),
        title: str(s?.title).slice(0, 200) || 'Etapa',
        ...(opts.followup
          ? { time_label: str(s?.time_label).slice(0, 60) }
          : {}),
        reveal: str(s?.reveal).slice(0, 4000),
        question,
        response_type: responseType,
        options,
        expected,
        common_errors: strings(s?.common_errors).slice(0, 10),
        max_turns:
          maxTurns >= 2 && maxTurns <= 10 ? maxTurns : DEFAULT_MAX_TURNS,
      });
      // Las etapas siguientes pueden condicionarse a los pasos de esta
      expected.forEach((i) => known.add(i.id));
    });
    return stages;
  }

  /**
   * Opciones de una etapa de selección: se enlazan a los pasos esperados
   * (por id desde el admin o por posición desde la IA), cada paso tiene su
   * opción y debe haber al menos un distractor; si no, la etapa queda abierta.
   */
  private normalizeOptions(
    s: any,
    expected: CaseExpectedItem[],
  ): { responseType: CaseResponseType; options: CaseOption[] } {
    let responseType: CaseResponseType =
      s?.response_type === 'single_choice' ||
      s?.response_type === 'multiple_choice'
        ? s.response_type
        : 'open';
    if (responseType === 'open') return { responseType, options: [] };

    const options: CaseOption[] = (Array.isArray(s?.options) ? s.options : [])
      .map((o: any): CaseOption => {
        let itemId: string | null = str(o?.item_id) || null;
        const index = o?.expected_index;
        if (!itemId && index !== null && index !== undefined && index !== '') {
          itemId = expected[Number(index)]?.id || null;
        }
        if (itemId && !expected.some((i) => i.id === itemId)) itemId = null;
        return {
          id: str(o?.id) || newId(),
          text: str(o?.text).slice(0, 300),
          item_id: itemId,
          unsafe: o?.unsafe === true || String(o?.unsafe) === 'true',
          why_not: itemId ? '' : str(o?.why_not).slice(0, 600),
        };
      })
      .filter((o: CaseOption) => o.text)
      .slice(0, 8);
    for (const item of expected) {
      if (!options.some((o) => o.item_id === item.id)) {
        options.push({
          id: newId(),
          text: item.text,
          item_id: item.id,
          unsafe: false,
          why_not: '',
        });
      }
    }
    const correct = options.filter((o) => o.item_id).length;
    if (responseType === 'single_choice' && correct > 1) {
      responseType = 'multiple_choice';
    }
    if (options.length < 3 || correct === options.length) {
      return { responseType: 'open', options: [] };
    }
    return { responseType, options };
  }

  /** Contenido de referencia: una actividad (transcript + documentos) o todo el curso. */
  private async material(event: Event, activityId: string | null) {
    let text = '';
    if (activityId) {
      if (!Types.ObjectId.isValid(activityId)) {
        throw new BadRequestException('Actividad inválida');
      }
      const activity = await this.activityModel
        .findOne({
          _id: new Types.ObjectId(activityId),
          event_id: { $in: idVariants(event._id) },
        })
        .exec();
      if (!activity) throw new NotFoundException('Actividad no encontrada');
      text = (await this.activityQuestions.buildMaterial(event, activity)).text;
    } else {
      text = (await this.courseContent.getMaterial(event, null)).content;
    }
    if (text.length < MIN_MATERIAL_CHARS) {
      throw new BadRequestException(
        'No hay contenido suficiente para generar un caso: agrega la transcripción de los videos o documentos a la actividad/curso.',
      );
    }
    return text;
  }

  private async event(organizationId: string, eventId: string) {
    const event = await this.eventModel
      .findOne({
        _id: this.objectId(eventId),
        organizer_id: { $in: idVariants(organizationId) },
      })
      .exec();
    if (!event) throw new NotFoundException('Curso no encontrado');
    return event;
  }

  private async caseDoc(organizationId: string, caseId: string) {
    const doc = await this.caseModel
      .findOne({
        _id: this.objectId(caseId),
        organization_id: new Types.ObjectId(organizationId),
      })
      .exec();
    if (!doc) throw new NotFoundException('Caso no encontrado');
    return doc;
  }

  private async mySession(
    uid: string,
    organizationId: string,
    sessionId: string,
  ) {
    const user = await this.usersService.findByFirebaseUid(uid);
    const session = await this.sessionModel
      .findOne({
        _id: this.objectId(sessionId),
        organization_id: new Types.ObjectId(organizationId),
        user_id: { $in: idVariants(user._id) },
      })
      .exec();
    if (!session) throw new NotFoundException('Intento no encontrado');
    return session;
  }

  private objectId(id: string) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('No encontrado');
    return new Types.ObjectId(id);
  }
}
