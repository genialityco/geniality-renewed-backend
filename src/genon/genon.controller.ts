import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SessionTokenGuard } from 'src/auth/session-token.guard';
import { GenOnProgramsService } from './genon-programs.service';
import { GenOnTemplatesService } from './genon-templates.service';
import { GenOnEngineService } from './genon-engine.service';
import { GenOnTriggersService, TRIGGER_STEP } from './genon-triggers.service';
import { GenOnHistoryService } from './genon-history.service';
import { GenOnTriggerKey } from './schemas/genon-program.schema';
import { GenOnFeedback } from './schemas/genon-feedback.schema';
import { GENON_VARIABLES, validateTemplate } from './genon-variables';
import { localDate, zonedTime } from './genon-schedule';

/**
 * Administración de Gen.ON. Un programa solo lo ve y edita quien administra
 * todas sus organizaciones; las plantillas (compartidas por la cuenta de
 * WhatsApp) las gestiona cualquier administrador.
 */
@UseGuards(SessionTokenGuard)
@Controller('genon')
export class GenOnController {
  constructor(
    private readonly programs: GenOnProgramsService,
    private readonly templates: GenOnTemplatesService,
    private readonly engine: GenOnEngineService,
    private readonly triggers: GenOnTriggersService,
    private readonly historyService: GenOnHistoryService,
    @InjectModel(GenOnFeedback.name)
    private readonly feedbackModel: Model<GenOnFeedback>,
  ) {}

  /** Variables y métricas disponibles para los textos y condiciones. */
  @Get('catalog')
  catalog() {
    return {
      variables: GENON_VARIABLES,
      metrics: [
        { key: 'n_egresados', label: 'Egresados del curso' },
        { key: 'n_activos_semana', label: 'Avanzaron en 7 días' },
        { key: 'n_avanzaron', label: 'Avanzaron en 14 días' },
        { key: 'pct_terminaron_desde_aqui', label: '% que terminó desde su módulo' },
        { key: 'base_desde_aqui', label: 'Colegas que llegaron a su módulo' },
        { key: 'avance', label: 'Avance del inscrito (%)' },
      ],
      triggers: [
        { key: 'exam_reminder', label: 'Recordatorio de examen' },
        { key: 'certificate', label: 'Certificado listo' },
        { key: 'streak_risk', label: 'Racha en riesgo' },
        { key: 'streak_recovery', label: 'Recuperación de racha' },
        { key: 'video_challenge', label: 'Reto del video' },
        { key: 'streak_milestone', label: 'Reconocimiento de racha' },
        { key: 'weekly_social', label: 'Comparación social semanal' },
        { key: 'module_completed', label: 'Acompañamiento: módulo terminado' },
      ].map((t) => ({ ...t, step: TRIGGER_STEP[t.key as GenOnTriggerKey] })),
      mechanics: [
        { key: 'message', label: 'Mensaje' },
        { key: 'abandon_question', label: 'Pregunta de abandono' },
        { key: 'social', label: 'Mensaje social' },
        { key: 'challenge_invite', label: 'Invitación al reto' },
        { key: 'closing', label: 'Cierre (pausa la secuencia)' },
      ],
    };
  }

  // ───────────────────────── Programas ─────────────────────────

  @Get('programs')
  list(@Req() req: any) {
    return this.programs.list(req.auth.uid);
  }

  @Post('programs')
  create(@Req() req: any, @Body() body: Record<string, any>) {
    return this.programs.create(req.auth.uid, body || {});
  }

  @Get('programs/:id')
  get(@Req() req: any, @Param('id') id: string) {
    return this.programs.get(req.auth.uid, id);
  }

  @Put('programs/:id')
  update(@Req() req: any, @Param('id') id: string, @Body() body: Record<string, any>) {
    return this.programs.update(req.auth.uid, id, body || {});
  }

  @Delete('programs/:id')
  remove(@Req() req: any, @Param('id') id: string) {
    return this.programs.remove(req.auth.uid, id);
  }

  /** Cursos del programa (para elegir uno en las pestañas). */
  @Get('programs/:id/courses')
  async courses(@Req() req: any, @Param('id') id: string) {
    const program = await this.programs.get(req.auth.uid, id);
    const events = await this.engine.programEvents(program);
    return events
      .map((e: any) => ({
        _id: String(e._id),
        name: e.name || 'Curso',
        organization_id: String(e.organizer_id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  @Get('programs/:id/courses/:eventId')
  async courseDetail(
    @Req() req: any,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
  ) {
    const program = await this.programs.get(req.auth.uid, id);
    return this.engine.courseDetail(program, eventId);
  }

  // ───────────────────────── Seguimiento ─────────────────────────

  @Get('programs/:id/enrollments')
  async enrollments(
    @Req() req: any,
    @Param('id') id: string,
    @Query('segment') segment?: string,
    @Query('eventId') eventId?: string,
    @Query('limit') limit?: string,
  ) {
    const program = await this.programs.get(req.auth.uid, id);
    return this.engine.listEnrollments(program, {
      segment: segment || undefined,
      eventId: eventId || undefined,
      limit: limit ? Number(limit) || undefined : undefined,
    });
  }

  /** Historial de una persona: mensajes, avance, retos y lo que escribió. */
  @Get('programs/:id/enrollments/:enrollmentId/history')
  async history(
    @Req() req: any,
    @Param('id') id: string,
    @Param('enrollmentId') enrollmentId: string,
  ) {
    const program = await this.programs.get(req.auth.uid, id);
    return this.historyService.history(program, enrollmentId);
  }

  @Get('programs/:id/feedback')
  async feedback(@Req() req: any, @Param('id') id: string) {
    const program = await this.programs.get(req.auth.uid, id);
    return this.feedbackModel
      .find({ program_id: String(program._id) })
      .sort({ created_at: -1 })
      .limit(500)
      .lean()
      .exec();
  }

  @Put('programs/:id/feedback/:feedbackId')
  async updateFeedback(
    @Req() req: any,
    @Param('id') id: string,
    @Param('feedbackId') feedbackId: string,
    @Body('status') status?: string,
  ) {
    const program = await this.programs.get(req.auth.uid, id);
    if (status !== 'open' && status !== 'closed') {
      throw new BadRequestException('"status" debe ser open o closed');
    }
    if (!Types.ObjectId.isValid(feedbackId)) {
      throw new BadRequestException('Caso inválido');
    }
    await this.feedbackModel
      .updateOne(
        { _id: new Types.ObjectId(feedbackId), program_id: String(program._id) },
        { $set: { status } },
      )
      .exec();
    return { status };
  }

  // ───────────────────────── Pruebas ─────────────────────────

  @Post('programs/:id/test/simulate')
  async simulate(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { userId?: string; eventId?: string },
  ) {
    const program = await this.programs.get(req.auth.uid, id);
    this.requireIds(body);
    return this.engine.simulate(program, body.userId!, body.eventId!);
  }

  @Post('programs/:id/test/preview')
  async preview(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { userId?: string; eventId?: string; stepKey?: string; variant?: number },
  ) {
    const program = await this.programs.get(req.auth.uid, id);
    this.requireIds(body);
    if (!body.stepKey) throw new BadRequestException('Falta el toque');
    return this.engine.preview(
      program,
      body.userId!,
      body.eventId!,
      body.stepKey,
      typeof body.variant === 'number' ? body.variant : undefined,
    );
  }

  @Post('programs/:id/test/send')
  async sendTest(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { userId?: string; eventId?: string; stepKey?: string; to?: string },
  ) {
    const program = await this.programs.get(req.auth.uid, id);
    this.requireIds(body);
    if (!body.stepKey) throw new BadRequestException('Falta el toque');
    return this.engine.sendTest(program, body.userId!, body.eventId!, body.stepKey, body.to || '');
  }

  /**
   * Segmenta y despacha ya, en simulación (nada se envía). Planea también lo
   * programado para el resto del día, registrado a la hora en que saldría,
   * para ver los datos sin esperar a cada franja. No se permite con el
   * programa activo: ahí los envíos son reales y los hace el cron.
   */
  @Post('programs/:id/run')
  async run(@Req() req: any, @Param('id') id: string) {
    const program = await this.programs.get(req.auth.uid, id);
    if (program.mode === 'live') {
      throw new BadRequestException(
        'El programa está activo: los envíos los hace el cron. Pásalo a simulación para probar.',
      );
    }
    const now = new Date();
    const endOfDay = zonedTime(localDate(now, program.timezone), '23:59', program.timezone);
    const { segmentation, detected, outcomes } = await this.triggers.run(program, now, {
      forceSegment: true,
      dryRun: true,
      budget: 500,
      planUntil: endOfDay,
    });
    const byResult: Record<string, number> = {};
    for (const o of outcomes) byResult[o.result] = (byResult[o.result] || 0) + 1;
    return {
      segmentation,
      detected,
      by_result: byResult,
      outcomes: outcomes.slice(0, 200),
    };
  }

  /**
   * Reparte de nuevo las franjas por igual y borra las variantes asignadas.
   * Vale también con el programa activo: no envía nada.
   */
  @Post('programs/:id/reassign')
  async reassign(@Req() req: any, @Param('id') id: string) {
    const program = await this.programs.get(req.auth.uid, id);
    return this.engine.reassign(program, new Date());
  }

  // ── Disparadores (segmento 3, examen, certificado) ──

  @Post('programs/:id/test/triggers')
  async simulateTriggers(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { userId?: string; eventId?: string },
  ) {
    const program = await this.programs.get(req.auth.uid, id);
    this.requireIds(body);
    return this.triggers.simulateForUser(program, body.userId!, body.eventId!);
  }

  @Post('programs/:id/test/triggers/preview')
  async previewTrigger(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { userId?: string; eventId?: string; key?: string },
  ) {
    const program = await this.programs.get(req.auth.uid, id);
    this.requireIds(body);
    return this.triggers.previewTrigger(
      program,
      body.userId!,
      body.eventId!,
      this.triggerKey(body.key),
    );
  }

  @Post('programs/:id/test/triggers/send')
  async sendTriggerTest(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { userId?: string; eventId?: string; key?: string; to?: string },
  ) {
    const program = await this.programs.get(req.auth.uid, id);
    this.requireIds(body);
    return this.triggers.sendTriggerTest(
      program,
      body.userId!,
      body.eventId!,
      this.triggerKey(body.key),
      body.to || '',
    );
  }

  private triggerKey(key?: string): GenOnTriggerKey {
    if (!key || !(key in TRIGGER_STEP)) {
      throw new BadRequestException('Disparador desconocido');
    }
    return key as GenOnTriggerKey;
  }

  // ───────────────────────── Plantillas ─────────────────────────

  @Get('templates')
  async listTemplates(@Req() req: any) {
    await this.requireAnyAdmin(req.auth.uid);
    const list = await this.templates.list();
    return list.map((t) => ({ ...t, errors: validateTemplate(t) }));
  }

  @Post('templates')
  async createTemplate(@Req() req: any, @Body() body: Record<string, any>) {
    await this.requireAnyAdmin(req.auth.uid);
    return this.templates.create(body || {});
  }

  @Put('templates/:id')
  async updateTemplate(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: Record<string, any>,
  ) {
    await this.requireAnyAdmin(req.auth.uid);
    return this.templates.update(id, body || {});
  }

  @Delete('templates/:id')
  async removeTemplate(@Req() req: any, @Param('id') id: string) {
    await this.requireAnyAdmin(req.auth.uid);
    return this.templates.remove(id);
  }

  @Post('templates/:id/submit')
  async submitTemplate(@Req() req: any, @Param('id') id: string) {
    await this.requireAnyAdmin(req.auth.uid);
    return this.templates.submit(id);
  }

  @Post('templates/sync')
  async syncTemplates(@Req() req: any) {
    await this.requireAnyAdmin(req.auth.uid);
    return this.templates.sync();
  }

  private requireIds(body: { userId?: string; eventId?: string }) {
    if (!body?.userId || !body?.eventId) {
      throw new BadRequestException('Faltan el usuario y el curso');
    }
  }

  private async requireAnyAdmin(uid: string) {
    const admin = await this.programs.adminOrganizationIds(uid);
    if (!admin.size) {
      throw new ForbiddenException('Necesitas ser administrador de una organización');
    }
  }
}
