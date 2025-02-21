import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Put,
  Delete,
} from '@nestjs/common';
import { ModulesService } from './modules.service';
import { Module } from './schemas/module.schema';

@Controller('modules')
export class ModulesController {
  constructor(private readonly modulesService: ModulesService) {}

  @Post()
  async create(@Body() module: Module): Promise<Module> {
    return this.modulesService.create(module);
  }

  @Get()
  async findAll(): Promise<Module[]> {
    return this.modulesService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<Module> {
    return this.modulesService.findOne(id);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() module: Module,
  ): Promise<Module> {
    return this.modulesService.update(id, module);
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
