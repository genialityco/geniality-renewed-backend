import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as AWS from 'aws-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { renderEmailLayout } from 'src/templates/Layout';

type InlineImage = {
  cid: string;
  filename: string;
  absPath: string;
  contentType?: string;
};

@Injectable()
export class EmailService {
  private ses: AWS.SES;
  private readonly logger = new Logger(EmailService.name);
  private readonly from: string;
  private readonly fromName: string;

  // Rutas locales por defecto (puedes sobreescribir con envs abajo)
  private readonly defaultHeroPath =
    'D:\\Trabajo\\Geniallity\\Repo\\Geniallity\\geniality-renewed-backend\\public\\img\\MAILS_HEADER.png';
  private readonly defaultLogosPath =
    'D:\\Trabajo\\Geniallity\\Repo\\Geniallity\\geniality-renewed-backend\\public\\img\\LOGOS_FOOTER.png';

  constructor(private configService: ConfigService) {
    this.ses = new AWS.SES({
      region: this.configService.get<string>('AWS_REGION'),
      accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID'),
      secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY'),
    });
    this.from = this.configService.get<string>('AWS_SES_EMAIL_FROM');
    this.fromName =
      this.configService.get<string>('AWS_SES_EMAIL_FROM_NAME') || 'No-Reply';
  }

  // ----------------- Helpers: limpieza y validación -----------------
  /** Remueve espacios/control invisibles y normaliza Unicode */
  private cleanEmail(email: string): string {
    if (typeof email !== 'string') return '';
    return (
      email
        .normalize('NFKC') // Normaliza Unicode
        .trim() // Quita espacios extremos
        // Quita caracteres de control ASCII (0x00–0x1F, 0x7F–0x9F)
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
        // Quita espacios de ancho cero y similares
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
        // Elimina cualquier whitespace restante (no deberían existir en emails)
        .replace(/\s+/g, '')
    );
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

    // Dedup
    return Array.from(new Set(cleaned));
  }

  /** Construye el campo Source asegurando limpieza en el from */
  private buildSource(fromEmail: string, fromName: string): string {
    const cleanFrom = this.cleanEmail(fromEmail);
    if (!this.isValidEmail(cleanFrom)) {
      throw new BadRequestException(`FROM inválido: ${fromEmail}`);
    }
    // Nota: fromName puede tener espacios; SES acepta "Name <email>"
    return `${fromName || this.fromName} <${cleanFrom}>`;
  }
  // ------------------------------------------------------------------

  // Método anterior, con limpieza/validación
  async sendEmail(to: string, subject: string, html: string) {
    const fromName = 'EndoCampus'; // Fijo (como tenías)
    const source = this.buildSource(this.from, fromName);
    const toList = this.prepareAddressList(to, 'to');

    const params: AWS.SES.SendEmailRequest = {
      Source: source,
      Destination: { ToAddresses: toList },
      Message: {
        Subject: { Data: subject },
        Body: { Html: { Data: html } },
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

  // NUEVO: Método universal y flexible (con limpieza/validación en to/cc/bcc/from)
  async sendUniversalEmail(body: any) {
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
      Subject: { Data: subject || '' },
      Body: {
        ...(html ? { Html: { Data: html } } : {}),
        ...(text ? { Text: { Data: text } } : {}),
      },
    };

    const params: AWS.SES.SendEmailRequest = {
      Source: source,
      Destination: {
        ToAddresses: toList,
        CcAddresses: ccList,
        BccAddresses: bccList,
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
  // =======================
  //   SendRawEmail + CIDs
  // =======================
  private guessContentType(file: string): string {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    return 'application/octet-stream';
  }

  /** Imágenes por defecto del layout (header/footer) */
  private defaultLayoutInlineImages(): InlineImage[] {
    const heroPath =
      this.configService.get<string>('MAIL_HERO_PATH') || this.defaultHeroPath;
    const logosPath =
      this.configService.get<string>('MAIL_LOGOS_PATH') || this.defaultLogosPath;

    return [
      {
        cid: 'hero@endo',
        filename: path.basename(heroPath) || 'MAILS_HEADER.png',
        absPath: heroPath,
        contentType: this.guessContentType(heroPath),
      },
      {
        cid: 'logos-footer@endo',
        filename: path.basename(logosPath) || 'LOGOS_FOOTER.png',
        absPath: logosPath,
        contentType: this.guessContentType(logosPath),
      },
    ];
  }

  /** Enviar con MIME multipart/related y adjuntos inline (CIDs) */
  async sendRawEmailWithInlineImages(
    to: string | string[],
    subject: string,
    html: string,
    images: InlineImage[],
  ) {
    const fromName = 'EndoCampus'; // Fijo (como tenías)
    const source = this.buildSource(this.from, fromName);
    const toList = this.prepareAddressList(to, 'to');
    if (!toList.length) throw new BadRequestException('Falta destinatario');

    const boundary = `REL-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const lines: string[] = [];

    // Parte HTML
    lines.push(
      `From: ${source}`,
      `To: ${toList.join(', ')}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/related; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset="UTF-8"`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      html,
    );

    // Adjuntos inline
    for (const img of images) {
      const fullPath = path.resolve(img.absPath);
      if (!fs.existsSync(fullPath)) {
        this.logger.error(`[SendRawEmail] Imagen no encontrada: ${fullPath} (cid=${img.cid})`);
        throw new BadRequestException(`No se encontró la imagen para el correo: ${img.filename}`);
      }
      const buf = fs.readFileSync(fullPath);
      const b64 = buf.toString('base64');

      lines.push(
        ``,
        `--${boundary}`,
        `Content-Type: ${img.contentType || 'image/png'}`,
        `Content-Transfer-Encoding: base64`,
        `Content-ID: <${img.cid}>`,
        `Content-Disposition: inline; filename="${img.filename}"`,
        ``,
        b64,
      );
    }

    // Cierre
    lines.push(``, `--${boundary}--`, ``);

    const rawData = lines.join('\r\n');
    const params: AWS.SES.SendRawEmailRequest = {
      RawMessage: { Data: Buffer.from(rawData) },
      Source: source,
      Destinations: toList,
    };

    const result = await this.ses.sendRawEmail(params).promise();
    this.logger.log(`[SendRawEmail] enviado a ${toList.join(', ')} (MessageId: ${result.MessageId})`);
    return result;
  }

  /**
   * Recibe SOLO el contentHtml. El layout (header/footer con CIDs) lo arma aquí.
   * Opcional: preheader y custom CIDs (si tuvieras variantes).
   */
  async sendLayoutEmail(
    to: string | string[],
    subject: string,
    contentHtml: string,
    opts?: { preheader?: string; heroCid?: string; logosCid?: string; blueBar?: boolean },
  ) {
    // 1) Render del layout con el content variable
    const fullHtml = renderEmailLayout({
      contentHtml,
      preheader: opts?.preheader,
      heroCid: opts?.heroCid || 'hero@endo',
      logosCid: opts?.logosCid || 'logos-footer@endo',
      blueBar: opts?.blueBar ?? true,
    });

    // 2) Adjuntar imágenes del layout (header/footer)
    const images = this.defaultLayoutInlineImages();

    // 3) Enviar por RAW + CIDs
    return this.sendRawEmailWithInlineImages(to, subject, fullHtml, images);
  }
}
