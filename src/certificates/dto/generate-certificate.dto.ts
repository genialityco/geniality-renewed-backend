import { CertificateFormat } from '../../certificate-templates/schemas/certificate-template.schema';

export class GenerateCertificateDto {
  eventId: string;
  format?: CertificateFormat;
  data: Record<string, string | number>;
  userId?: string;
}
