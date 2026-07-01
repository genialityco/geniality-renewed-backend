import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { CertificateTemplate } from './schemas/certificate-template.schema';
import { UpsertCertificateTemplateDto } from './dto/upsert-certificate-template.dto';
import { uploadBufferToStorage } from './certificate-storage.util';

type UploadedImageFile = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
};

const ALLOWED_IMAGE_MIMETYPES = ['image/png', 'image/jpeg', 'image/jpg'];
const MAX_BACKGROUND_SIZE_BYTES = 10 * 1024 * 1024;

@Injectable()
export class CertificateTemplatesService {
  private readonly logger = new Logger(CertificateTemplatesService.name);

  constructor(
    @InjectModel(CertificateTemplate.name)
    private certificateTemplateModel: Model<CertificateTemplate>,
  ) {}

  async getByEventId(eventId: string): Promise<CertificateTemplate | null> {
    return this.certificateTemplateModel
      .findOne({ eventId: new Types.ObjectId(eventId) })
      .exec();
  }

  async upsertForEvent(
    eventId: string,
    dto: UpsertCertificateTemplateDto,
  ): Promise<CertificateTemplate> {
    if (!dto.backgroundUrl) {
      throw new BadRequestException('backgroundUrl es requerido');
    }
    if (!dto.width || !dto.height) {
      throw new BadRequestException('width y height son requeridos');
    }
    if (!dto.fields?.length) {
      throw new BadRequestException('El certificado debe tener al menos un campo');
    }

    const template = await this.certificateTemplateModel.findOneAndUpdate(
      { eventId: new Types.ObjectId(eventId) },
      {
        eventId: new Types.ObjectId(eventId),
        name: dto.name,
        description: dto.description,
        backgroundUrl: dto.backgroundUrl,
        width: dto.width,
        height: dto.height,
        format: dto.format || 'PNG',
        status: dto.status || 'ACTIVE',
        fields: dto.fields,
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    this.logger.log(`Certificate template saved for event ${eventId}`);
    return template;
  }

  async deleteForEvent(eventId: string): Promise<void> {
    const result = await this.certificateTemplateModel.findOneAndDelete({
      eventId: new Types.ObjectId(eventId),
    });
    if (!result) {
      throw new NotFoundException('No hay certificado configurado para este evento');
    }
  }

  async uploadBackground(
    file: UploadedImageFile,
  ): Promise<{ url: string }> {
    if (!file) {
      throw new BadRequestException('File is required');
    }
    if (!ALLOWED_IMAGE_MIMETYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        'Formato de imagen no soportado. Usa PNG o JPG.',
      );
    }
    if (file.size > MAX_BACKGROUND_SIZE_BYTES) {
      throw new BadRequestException('La imagen no puede superar los 10MB.');
    }

    const extension = file.mimetype === 'image/png' ? 'png' : 'jpg';
    const path = `certificate-templates/${Date.now()}-${uuidv4()}.${extension}`;
    const { url } = await uploadBufferToStorage(path, file.buffer, file.mimetype);
    return { url };
  }
}
