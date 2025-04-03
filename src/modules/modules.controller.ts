import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Put,
  Patch,
  Delete,
} from '@nestjs/common';
import { ModulesService } from './modules.service';
import { Module } from './schemas/module.schema';

@Controller('modules')
export class ModulesController {
  constructor(private readonly modulesService: ModulesService) {}

  @Post()
  async create(@Body() moduleData: any): Promise<Module> {
    return this.modulesService.create(moduleData);
  }

  @Get()
  async findAll(): Promise<Module[]> {
    return this.modulesService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<Module> {
    return this.modulesService.findOne(id);
  }

  // Opción 1: seguiste con PUT (reemplazo completo)
  @Put(':id')
  async updatePut(
    @Param('id') id: string,
    @Body() moduleData: any,
  ): Promise<Module> {
    return this.modulesService.update(id, moduleData);
  }

  // Opción 2: PATCH para actualizaciones parciales (opcional)
  @Patch(':id')
  async updatePatch(
    @Param('id') id: string,
    @Body() moduleData: any,
  ): Promise<Module> {
    return this.modulesService.update(id, moduleData);
  }

  @Delete(':id')
  async delete(@Param('id') id: string): Promise<Module> {
    return this.modulesService.delete(id);
  }

  @Get('event/:event_id')
  async findByEventId(@Param('event_id') event_id: string): Promise<Module[]> {
    return this.modulesService.findByEventId(event_id);
  }
}
