import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Delete,
} from '@nestjs/common';
import { CompletionMessagesService } from './completion-messages.service';
import { CompletionMessage, CompletionMessageType } from './schemas/completion-message.schema';

@Controller('completion-messages')
export class CompletionMessagesController {
  constructor(
    private readonly completionMessagesService: CompletionMessagesService,
  ) {}

  @Post()
  create(
    @Body()
    createDto: {
      organization_id: string;
      blocks: any[];
      type?: CompletionMessageType;
      active?: boolean;
      order?: number;
    },
  ) {
    return this.completionMessagesService.create(createDto);
  }

  @Get('organization/:organizationId')
  findByOrganization(@Param('organizationId') organizationId: string) {
    return this.completionMessagesService.findByOrganization(organizationId);
  }

  @Get('organization/:organizationId/type/:type')
  findByOrganizationAndType(
    @Param('organizationId') organizationId: string,
    @Param('type') type: CompletionMessageType,
  ) {
    return this.completionMessagesService.findByOrganizationAndType(organizationId, type);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.completionMessagesService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateDto: Partial<CompletionMessage>,
  ) {
    return this.completionMessagesService.update(id, updateDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.completionMessagesService.delete(id);
  }

  @Delete('organization/:organizationId')
  removeByOrganization(@Param('organizationId') organizationId: string) {
    return this.completionMessagesService.deleteByOrganization(organizationId);
  }
}
