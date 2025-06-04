import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Put,
  Delete,
} from '@nestjs/common';
import { HostsService } from './hosts.service';
import { Host } from './schemas/host.schema';

@Controller('hosts')
export class HostsController {
  constructor(private readonly hostsService: HostsService) {}

  @Post()
  async create(@Body() createHost: any): Promise<Host> {
    return this.hostsService.create(createHost);
  }

  @Get()
  async findAll(): Promise<Host[]> {
    return this.hostsService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<Host> {
    return this.hostsService.findOne(id);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() updateHost: any,
  ): Promise<Host> {
    return this.hostsService.update(id, updateHost);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<Host> {
    return this.hostsService.remove(id);
  }

  // NUEVO: Endpoint para consultar hosts por event_id
  @Get('event/:event_id')
  async findByEventId(@Param('event_id') eventId: string): Promise<Host[]> {
    return this.hostsService.findByEventId(eventId);
  }
}
