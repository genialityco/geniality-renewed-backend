import {
  CertificateFieldDataSource,
  CertificateFieldType,
  CertificateFormat,
} from '../schemas/certificate-template.schema';

export class TemplateFieldElementDto {
  name: string;
  label: string;
  type?: CertificateFieldType;
  required?: boolean;
  defaultValue?: string;
  dataSource?: CertificateFieldDataSource;
  posX: number;
  posY: number;
  width?: number;
  height?: number;
  fontSize?: number;
  fontFamily?: string;
  fontColor?: string;
  fontWeight?: 'normal' | 'bold';
  textAlign?: 'left' | 'center' | 'right';
  rotation?: number;
  order?: number;
}

export class UpsertCertificateTemplateDto {
  name?: string;
  description?: string;
  backgroundUrl: string;
  width: number;
  height: number;
  format?: CertificateFormat;
  status?: 'ACTIVE' | 'INACTIVE';
  fields: TemplateFieldElementDto[];
}
