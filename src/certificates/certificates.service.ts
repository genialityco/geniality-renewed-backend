import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Certificate } from './schemas/certificate.schema';
import {
  CertificateTemplate,
  TemplateFieldElement,
} from '../certificate-templates/schemas/certificate-template.schema';
import { GenerateCertificateDto } from './dto/generate-certificate.dto';
import {
  downloadBufferFromStorage,
  uploadBufferToStorage,
} from '../certificate-templates/certificate-storage.util';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');

export interface CertificateFileDelivery {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => {
    switch (char) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      case '"':
        return '&quot;';
      default:
        return char;
    }
  });
}

function normalizeKey(key: string): string {
  return key.toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveFieldValue(
  field: TemplateFieldElement,
  data: Record<string, string | number>,
): string {
  const normalizedData: Record<string, string | number> = {};
  Object.keys(data || {}).forEach((key) => {
    normalizedData[normalizeKey(key)] = data[key];
  });

  const value =
    data?.[field.name] ??
    normalizedData[normalizeKey(field.name)] ??
    normalizedData[normalizeKey(field.label)] ??
    field.defaultValue ??
    '';

  return String(value);
}

function buildSvgOverlay(
  template: CertificateTemplate,
  data: Record<string, string | number>,
): string {
  const texts = [...template.fields]
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((field) => {
      const value = escapeXml(resolveFieldValue(field, data));
      const anchor =
        field.textAlign === 'left'
          ? 'start'
          : field.textAlign === 'right'
            ? 'end'
            : 'middle';

      // posX/posY mark the center of the field's box (matches the drag-and-drop
      // editor, where a field is dragged by its visual center).
      let x = field.posX;
      if (anchor === 'start') x = field.posX - field.width / 2;
      else if (anchor === 'end') x = field.posX + field.width / 2;

      const y = field.posY + field.fontSize / 3;
      const transformAttr = field.rotation
        ? ` transform="rotate(${field.rotation} ${x} ${y})"`
        : '';

      return `<text x="${x}" y="${y}" font-family="${escapeXml(field.fontFamily)}" font-size="${field.fontSize}" font-weight="${field.fontWeight}" fill="${field.fontColor}" text-anchor="${anchor}"${transformAttr}>${value}</text>`;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${template.width}" height="${template.height}">${texts}</svg>`;
}

@Injectable()
export class CertificatesService {
  private readonly logger = new Logger(CertificatesService.name);

  constructor(
    @InjectModel(Certificate.name)
    private certificateModel: Model<Certificate>,
    @InjectModel(CertificateTemplate.name)
    private certificateTemplateModel: Model<CertificateTemplate>,
  ) {}

  private async renderPng(
    template: CertificateTemplate,
    data: Record<string, string | number>,
  ): Promise<Buffer> {
    const response = await fetch(template.backgroundUrl);
    if (!response.ok) {
      throw new Error('No se pudo descargar la imagen de fondo del certificado');
    }
    const backgroundBuffer = Buffer.from(await response.arrayBuffer());
    const overlayBuffer = Buffer.from(buildSvgOverlay(template, data));

    return sharp(backgroundBuffer)
      .resize(template.width, template.height, { fit: 'fill' })
      .composite([{ input: overlayBuffer, top: 0, left: 0 }])
      .png()
      .toBuffer();
  }

  private async renderPdf(
    template: CertificateTemplate,
    data: Record<string, string | number>,
  ): Promise<Buffer> {
    const pngBuffer = await this.renderPng(template, data);

    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        size: [template.width, template.height],
        margin: 0,
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.image(pngBuffer, 0, 0, {
        width: template.width,
        height: template.height,
      });
      doc.end();
    });
  }

  async generate(dto: GenerateCertificateDto): Promise<Certificate> {
    const template = await this.certificateTemplateModel.findOne({
      eventId: new Types.ObjectId(dto.eventId),
      status: 'ACTIVE',
    });

    if (!template) {
      throw new NotFoundException(
        'Este evento no tiene un certificado configurado',
      );
    }

    const format = dto.format || template.format || 'PNG';

    const certificate = await this.certificateModel.create({
      eventId: template.eventId,
      templateId: template._id,
      userId: dto.userId ? new Types.ObjectId(dto.userId) : undefined,
      data: dto.data,
      format,
      status: 'PENDING',
    });

    try {
      const buffer =
        format === 'PDF'
          ? await this.renderPdf(template, dto.data)
          : await this.renderPng(template, dto.data);

      const extension = format === 'PDF' ? 'pdf' : 'png';
      const contentType = format === 'PDF' ? 'application/pdf' : 'image/png';
      const path = `certificates/${template._id}/${certificate._id}.${extension}`;

      const { filePath, url } = await uploadBufferToStorage(
        path,
        buffer,
        contentType,
      );

      certificate.filePath = filePath;
      certificate.fileUrl = url;
      certificate.status = 'COMPLETED';
      certificate.generatedAt = new Date();
      await certificate.save();
    } catch (error: any) {
      certificate.status = 'FAILED';
      certificate.errorMessage = error.message;
      await certificate.save();
      this.logger.error(
        `Error generating certificate ${certificate._id}: ${error.message}`,
        error.stack,
      );
    }

    return certificate;
  }

  async getFileDelivery(certificateId: string): Promise<CertificateFileDelivery> {
    const certificate = await this.certificateModel.findById(certificateId);
    if (!certificate) {
      throw new NotFoundException('Certificado no encontrado');
    }
    if (certificate.status !== 'COMPLETED' || !certificate.filePath) {
      throw new NotFoundException('El certificado aún no está listo');
    }

    const buffer = await downloadBufferFromStorage(certificate.filePath);
    const contentType =
      certificate.format === 'PDF' ? 'application/pdf' : 'image/png';
    const extension = certificate.format === 'PDF' ? 'pdf' : 'png';

    return {
      buffer,
      contentType,
      filename: `certificado-${certificate._id}.${extension}`,
    };
  }
}
