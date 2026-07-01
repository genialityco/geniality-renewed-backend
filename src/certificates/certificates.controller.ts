import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { CertificatesService } from './certificates.service';
import { GenerateCertificateDto } from './dto/generate-certificate.dto';
import { SessionTokenGuard } from '../auth/session-token.guard';

@Controller('certificates')
export class CertificatesController {
  constructor(private readonly certificatesService: CertificatesService) {}

  @Post('generate')
  @UseGuards(SessionTokenGuard)
  async generate(@Body() dto: GenerateCertificateDto) {
    const certificate = await this.certificatesService.generate(dto);
    const plain = certificate.toObject();
    return {
      ...plain,
      viewUrl: `/certificates/${certificate._id}/view`,
      downloadUrl: `/certificates/${certificate._id}/download`,
    };
  }

  @Get(':id/view')
  async view(@Param('id') id: string, @Res() res: Response) {
    const { buffer, contentType } =
      await this.certificatesService.getFileDelivery(id);
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': 'inline',
    });
    res.send(buffer);
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const { buffer, contentType, filename } =
      await this.certificatesService.getFileDelivery(id);
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(buffer);
  }
}
