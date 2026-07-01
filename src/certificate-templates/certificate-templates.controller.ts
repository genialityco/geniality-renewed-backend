import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CertificateTemplatesService } from './certificate-templates.service';
import { UpsertCertificateTemplateDto } from './dto/upsert-certificate-template.dto';
import { SessionTokenGuard } from '../auth/session-token.guard';

type UploadedImageFile = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
};

@Controller('certificate-templates')
export class CertificateTemplatesController {
  constructor(
    private readonly certificateTemplatesService: CertificateTemplatesService,
  ) {}

  @Get('event/:eventId')
  @UseGuards(SessionTokenGuard)
  async getByEventId(@Param('eventId') eventId: string) {
    return this.certificateTemplatesService.getByEventId(eventId);
  }

  @Put('event/:eventId')
  @UseGuards(SessionTokenGuard)
  async upsertForEvent(
    @Param('eventId') eventId: string,
    @Body() dto: UpsertCertificateTemplateDto,
  ) {
    return this.certificateTemplatesService.upsertForEvent(eventId, dto);
  }

  @Delete('event/:eventId')
  @UseGuards(SessionTokenGuard)
  async deleteForEvent(@Param('eventId') eventId: string) {
    await this.certificateTemplatesService.deleteForEvent(eventId);
    return { message: 'Certificado eliminado correctamente' };
  }

  @Post('upload-background')
  @UseGuards(SessionTokenGuard)
  @UseInterceptors(FileInterceptor('file'))
  async uploadBackground(@UploadedFile() file: UploadedImageFile) {
    return this.certificateTemplatesService.uploadBackground(file);
  }
}
