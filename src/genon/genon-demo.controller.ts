import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionTokenGuard } from 'src/auth/session-token.guard';
import { GenOnProgramsService } from './genon-programs.service';
import { GenOnDemoService } from './genon-demo.service';

/**
 * Demostración guiada de Gen.ON (pestaña "Demostración" del admin). Mismo
 * permiso que el programa: quien administra todas sus organizaciones.
 */
@UseGuards(SessionTokenGuard)
@Controller('genon/programs/:id/demo')
export class GenOnDemoController {
  constructor(
    private readonly programs: GenOnProgramsService,
    private readonly demos: GenOnDemoService,
  ) {}

  /** El guion (con lo que falta para cada paso) y la demostración en curso, si hay. */
  @Get()
  async current(@Req() req: any, @Param('id') id: string) {
    const program = await this.programs.get(req.auth.uid, id);
    const demo = await this.demos.current(program);
    return {
      program_mode: program.mode,
      stages: await this.demos.script(program, demo?.event_id || null),
      demo: demo ? await this.demos.status(program, demo) : null,
    };
  }

  @Post()
  async create(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { name?: string; eventId?: string },
  ) {
    const program = await this.programs.get(req.auth.uid, id);
    const demo = await this.demos.create(program, req.auth.uid, body || {});
    return this.demos.status(program, demo);
  }

  /** Estado en vivo (la pantalla lo consulta cada pocos segundos). */
  @Get(':demoId')
  async status(@Req() req: any, @Param('id') id: string, @Param('demoId') demoId: string) {
    const program = await this.programs.get(req.auth.uid, id);
    return this.demos.status(program, await this.demos.get(program, demoId));
  }

  /** Termina la demostración y borra a los participantes y lo que generaron. */
  @Delete(':demoId')
  async remove(@Req() req: any, @Param('id') id: string, @Param('demoId') demoId: string) {
    const program = await this.programs.get(req.auth.uid, id);
    return this.demos.remove(program, await this.demos.get(program, demoId));
  }

  @Post(':demoId/participants')
  async addParticipant(
    @Req() req: any,
    @Param('id') id: string,
    @Param('demoId') demoId: string,
    @Body() body: { name?: string; phone?: string },
  ) {
    const program = await this.programs.get(req.auth.uid, id);
    const demo = await this.demos.get(program, demoId);
    await this.demos.addParticipant(program, demo, body || {});
    return this.demos.status(program, demo);
  }

  @Delete(':demoId/participants/:userId')
  async removeParticipant(
    @Req() req: any,
    @Param('id') id: string,
    @Param('demoId') demoId: string,
    @Param('userId') userId: string,
  ) {
    const program = await this.programs.get(req.auth.uid, id);
    const demo = await this.demos.get(program, demoId);
    await this.demos.removeParticipant(program, demo, userId);
    return this.demos.status(program, await this.demos.get(program, demoId));
  }

  /** Deja a todos los participantes en la situación de la etapa. */
  @Post(':demoId/stage')
  async prepareStage(
    @Req() req: any,
    @Param('id') id: string,
    @Param('demoId') demoId: string,
    @Body() body: { stage?: string },
  ) {
    const program = await this.programs.get(req.auth.uid, id);
    if (!body?.stage) throw new BadRequestException('Falta la etapa');
    const demo = await this.demos.get(program, demoId);
    await this.demos.prepareStage(program, demo, body.stage);
    return this.demos.status(program, demo);
  }

  /** Envía un paso de la etapa actual (a todos o a los indicados). */
  @Post(':demoId/send')
  async send(
    @Req() req: any,
    @Param('id') id: string,
    @Param('demoId') demoId: string,
    @Body() body: { stepId?: string; userIds?: string[] },
  ) {
    const program = await this.programs.get(req.auth.uid, id);
    if (!body?.stepId) throw new BadRequestException('Falta el paso');
    const demo = await this.demos.get(program, demoId);
    return this.demos.sendStep(
      program,
      demo,
      body.stepId,
      Array.isArray(body.userIds) ? body.userIds.map(String) : undefined,
    );
  }
}
