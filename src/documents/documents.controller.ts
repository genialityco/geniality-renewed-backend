/// <reference types="multer" />
import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  UseGuards,
  Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentsService } from './documents.service';
import { UploadDocumentDto, AssociateDocumentDto } from './dto/upload-document.dto';
import { SessionTokenGuard } from '../auth/session-token.guard';

@Controller('documents')
@UseGuards(SessionTokenGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadDocument(
    @UploadedFile() file: Express.Multer.File,
    @Body() uploadDto: UploadDocumentDto,
    @Req() req: any,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    const userId: string =
      req.auth?.uid ||
      req.headers['x-uid'] ||
      req.headers['x_uid'];
    return this.documentsService.uploadDocument(file, uploadDto, userId);
  }

  @Get('organization/:organizationId')
  async getDocumentsByOrganization(
    @Param('organizationId') organizationId: string,
    @Query('eventId') eventId?: string,
    @Query('moduleId') moduleId?: string,
    @Query('activityId') activityId?: string,
  ) {
    return this.documentsService.getDocumentsByOrganization(organizationId, {
      eventId,
      moduleId,
      activityId,
    });
  }

  @Get('search/:organizationId')
  async searchDocuments(
    @Param('organizationId') organizationId: string,
    @Query('q') searchTerm: string,
  ) {
    if (!searchTerm) {
      throw new BadRequestException('Search term is required');
    }

    return this.documentsService.searchDocuments(organizationId, searchTerm);
  }

  @Get(':documentId')
  async getDocumentById(@Param('documentId') documentId: string) {
    return this.documentsService.getDocumentById(documentId);
  }

  @Get(':documentId/content')
  async getDocumentContent(@Param('documentId') documentId: string) {
    return {
      content: await this.documentsService.getDocumentContent(documentId),
    };
  }

  @Patch(':documentId/associate')
  async associateDocument(
    @Param('documentId') documentId: string,
    @Body() associateDto: AssociateDocumentDto,
  ) {
    return this.documentsService.associateDocument(documentId, associateDto);
  }

  @Delete(':documentId')
  async deleteDocument(@Param('documentId') documentId: string) {
    await this.documentsService.deleteDocument(documentId);
    return { message: 'Document deleted successfully' };
  }
}
