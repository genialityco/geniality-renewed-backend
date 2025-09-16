import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as AWS from 'aws-sdk';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Organization } from 'src/organizations/schemas/organization.schema';
import { OrganizationUser } from 'src/organization-users/schemas/organization-user.schema'; // ajusta ruta
import { renderEmailLayout } from 'src/templates/Layout';


type OrgStylesLean = {
  style?: { banner_image_email?: string; FooterImage?: string; footerImage?: string };
  styles?: { banner_image_email?: string; FooterImage?: string; footerImage?: string };
};


@Injectable()
export class EmailService {
  private ses: AWS.SES;
  private readonly logger = new Logger(EmailService.name);
  private readonly from: string;
  private readonly fromName: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectModel(Organization.name) private readonly orgModel: Model<Organization>,
    @InjectModel(OrganizationUser.name) private readonly orgUserModel: Model<OrganizationUser>,
  ) {
    this.ses = new AWS.SES({
      region: this.configService.get<string>('AWS_REGION'),
      accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID'),
      secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY'),
    });
    this.from = this.configService.get<string>('AWS_SES_EMAIL_FROM');
    this.fromName =
      this.configService.get<string>('AWS_SES_EMAIL_FROM_NAME') || 'EndoCampus';
  }

  // ----------------- Helpers: limpieza y validación -----------------
  /** Remueve espacios/control invisibles y normaliza Unicode */
  private cleanEmail(email: string): string {
    if (typeof email !== 'string') return '';
    return email
      .normalize('NFKC')
      .trim()
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/\s+/g, '');
  }

  /** Regex sencilla y suficiente para SES (sin espacios) */
  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  /** Limpia, valida y deduplica un conjunto de correos */
  private prepareAddressList(
    input?: string | string[],
    fieldName = 'to',
  ): string[] {
    if (!input) return [];
    const arr = Array.isArray(input) ? input : [input];

    const cleaned = arr
      .map((raw) => {
        const e = this.cleanEmail(raw);
        if (!this.isValidEmail(e)) {
          this.logger.warn(
            `Email inválido en "${fieldName}": "${raw}" -> "${e}"`,
          );
          throw new BadRequestException(
            `Correo inválido en "${fieldName}": ${raw}`,
          );
        }
        return e;
      })
      .filter(Boolean);

    return Array.from(new Set(cleaned)); // dedup
  }

  /** Construye el campo Source asegurando limpieza en el from */
  private buildSource(fromEmail: string, fromName: string): string {
    const cleanFrom = this.cleanEmail(fromEmail);
    if (!this.isValidEmail(cleanFrom)) {
      throw new BadRequestException(`FROM inválido: ${fromEmail}`);
    }
    // SES acepta "Name <email>"
    return `${fromName || this.fromName} <${cleanFrom}>`;
  }
  // ------------------------------------------------------------------

  // ======================
  // Envío básico (SendEmail)
  // ======================
  async sendEmail(to: string | string[], subject: string, html: string) {
    const source = this.buildSource(this.from, this.fromName);
    const toList = this.prepareAddressList(to, 'to');

    const params: AWS.SES.SendEmailRequest = {
      Source: source,
      Destination: { ToAddresses: toList },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Html: { Data: html, Charset: 'UTF-8' } },
      },
    };

    try {
      const result = await this.ses.sendEmail(params).promise();
      this.logger.log(
        `Email enviado a ${toList.join(', ')} (MessageId: ${result.MessageId})`,
      );
      return result;
    } catch (error: any) {
      this.logger.error(
        `Error enviando email a ${toList.join(', ')}: ${error?.message || error}`,
      );
      throw error;
    }
  }

  // ======================
  // Universal (to/cc/bcc/fromName/fromEmail)
  // ======================
  async sendUniversalEmail(body: {
    to: string | string[];
    subject: string;
    html: string;
    fromName?: string;
    fromEmail?: string;
    cc?: string | string[];
    bcc?: string | string[];
    text?: string;
  }) {
    const {
      to,
      cc,
      bcc,
      subject,
      html,
      fromName,
      fromEmail,
      text, // opcional
    } = body ?? {};

    const source = this.buildSource(
      fromEmail || this.from,
      fromName || this.fromName,
    );

    const toList = this.prepareAddressList(to, 'to');
    const ccList = this.prepareAddressList(cc, 'cc');
    const bccList = this.prepareAddressList(bcc, 'bcc');

    if (toList.length === 0 && ccList.length === 0 && bccList.length === 0) {
      throw new BadRequestException(
        'Debe especificar al menos un destinatario (to/cc/bcc).',
      );
    }

    const message: AWS.SES.Message = {
      Subject: { Data: subject || '', Charset: 'UTF-8' },
      Body: {
        ...(html ? { Html: { Data: html, Charset: 'UTF-8' } } : {}),
        ...(text ? { Text: { Data: text, Charset: 'UTF-8' } } : {}),
      },
    };

    const params: AWS.SES.SendEmailRequest = {
      Source: source,
      Destination: {
        ToAddresses: toList,
        CcAddresses: ccList.length ? ccList : undefined,
        BccAddresses: bccList.length ? bccList : undefined,
      },
      Message: message,
    };

    try {
      const result = await this.ses.sendEmail(params).promise();
      this.logger.log(
        `[Universal] Email enviado a ${[
          ...toList,
          ...ccList.map((e) => `cc:${e}`),
          ...bccList.map((e) => `bcc:${e}`),
        ].join(', ')} (MessageId: ${result.MessageId})`,
      );
      return result;
    } catch (error: any) {
      this.logger.error(
        `[Universal] Error enviando email: ${error?.message || error}`,
      );
      throw error;
    }
  }

  // ======================
  // Layout con imágenes desde Organization
  // ======================

  /**
   * Devuelve EXACTAMENTE lo que está en la colección para esa org:
   * - heroUrl = styles.banner_image_email || style.banner_image_email || ''
   * - logosUrl = styles.footerImage || style.footerImage || ''
   * Si no hay organizationUserId, retorna ambos en '' (no renderiza imágenes).
   */
  private async resolveStrictForOrg(dataId?: string) {
    if (!dataId) {
      return { heroUrl: '', logosUrl: '' };
    }

    // 1) ¿Es un Organization?
    const orgDirect = await this.orgModel
      .findById(dataId)
      .select({ style: 1, styles: 1 })
      .lean<OrgStylesLean>()
      .exec();

    if (orgDirect) {
      const st = orgDirect.style ?? orgDirect.styles ?? {};
      return {
        heroUrl: (st?.banner_image_email ?? '').trim(),
        logosUrl: (st?.FooterImage ?? st?.footerImage ?? '').trim(),
      };
    }

    // 2) Si no es Organization, intento como OrganizationUser
    const orgUser = await this.orgUserModel
      .findById(dataId)
      .select({ organization_id: 1 })
      .lean<{ organization_id?: string | any }>()
      .exec();

    const organizationId =
      orgUser?.organization_id ? String(orgUser.organization_id) : undefined;

    if (!organizationId) {
      return { heroUrl: '', logosUrl: '' };
    }

    // 3) Con organizationId, ahora sí leo Organization
    const org = await this.orgModel
      .findById(organizationId)
      .select({ style: 1, styles: 1 })
      .lean<OrgStylesLean>()
      .exec();

    const st = org?.style ?? org?.styles ?? {};
    return {
      heroUrl: (st?.banner_image_email ?? '').trim(),
      logosUrl: (st?.FooterImage ?? st?.footerImage ?? '').trim(),
    };
  }

  /**
   * Rindea el layout usando <img src="https://..."> con URLs públicas
   * obtenidas de la colección. Si la org no tiene imágenes, no las imprime.
   */
  async sendLayoutEmail(
    to: string | string[],
    subject: string,
    contentHtml: string,
    dataId: string,
    opts?: {
      preheader?: string;
      blueBar?: boolean;
      heroUrl?: string;  // override explícito (opcional)
      logosUrl?: string; // override explícito (opcional)
    },
  ) {
    console.log('sendLayoutEmail opts:', dataId);
    const { heroUrl: orgHero, logosUrl: orgLogos } = await this.resolveStrictForOrg(dataId);

    // Si te pasan overrides explícitos, se usan; si no, lo de la colección (o "")
    const heroUrl = (opts?.heroUrl ?? orgHero) || '';
    const logosUrl = (opts?.logosUrl ?? orgLogos) || '';

    const fullHtml = renderEmailLayout({
      contentHtml,
      preheader: opts?.preheader,
      blueBar: opts?.blueBar ?? true,
      heroCid: heroUrl,   // URL pública o ''
      logosCid: logosUrl,  // URL pública o ''
    });

    return this.sendEmail(to, subject, fullHtml);
  }
}
