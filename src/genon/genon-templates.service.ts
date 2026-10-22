import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { WhatsappGatewayClient } from 'src/reminders/whatsapp-gateway.client';
import { GenOnTemplate } from './schemas/genon-template.schema';
import { DEFAULT_TEMPLATES } from './genon-defaults';
import { buildMetaTemplate, validateTemplate } from './genon-variables';

const CONTENT_FIELDS = ['body', 'footer', 'buttons', 'category', 'language'];

const baseUrl = () =>
  (process.env.WHATSAPP_REMINDER_BASE_URL || 'https://app.geniality.com.co').replace(
    /\/+$/,
    '',
  );

/**
 * Plantillas de Gen.ON y su ciclo en Meta: borrador → enviada a revisión
 * (PENDING) → aprobada o rechazada. Se crean por la API de Meta a través
 * del gateway.
 */
@Injectable()
export class GenOnTemplatesService implements OnModuleInit {
  private readonly logger = new Logger(GenOnTemplatesService.name);

  constructor(
    @InjectModel(GenOnTemplate.name)
    private readonly templateModel: Model<GenOnTemplate>,
    private readonly gateway: WhatsappGatewayClient,
  ) {}

  /** Crea en borrador las plantillas del documento que falten. */
  async onModuleInit() {
    try {
      for (const t of DEFAULT_TEMPLATES) {
        await this.templateModel.updateOne(
          { key: t.key },
          {
            $setOnInsert: {
              ...t,
              language: 'es',
              category: 'UTILITY',
              footer: '',
              version: 1,
              meta_status: 'DRAFT',
            },
          },
          { upsert: true },
        );
      }
    } catch (error) {
      this.logger.warn(
        `No se pudieron crear las plantillas por defecto: ${(error as Error).message}`,
      );
    }
  }

  list() {
    return this.templateModel.find().sort({ key: 1 }).lean().exec();
  }

  async byKey(key: string): Promise<GenOnTemplate | null> {
    return this.templateModel.findOne({ key }).lean<GenOnTemplate>().exec();
  }

  async get(id: string): Promise<GenOnTemplate> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Plantilla no encontrada');
    }
    const t = await this.templateModel.findById(id).exec();
    if (!t) throw new NotFoundException('Plantilla no encontrada');
    return t;
  }

  async create(body: Record<string, any>) {
    const key = String(body?.key || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_');
    if (!key) throw new BadRequestException('La plantilla necesita una clave');
    if (await this.templateModel.exists({ key })) {
      throw new BadRequestException(`Ya existe una plantilla "${key}"`);
    }
    return this.templateModel.create({
      key,
      label: String(body.label || key),
      body: String(body.body || ''),
      footer: String(body.footer || ''),
      buttons: Array.isArray(body.buttons) ? body.buttons : [],
      category: body.category === 'MARKETING' ? 'MARKETING' : 'UTILITY',
      language: String(body.language || 'es'),
    });
  }

  /**
   * Editar una plantilla que ya se envió a Meta la vuelve a borrador con una
   * versión nueva: Meta no permite cambiar libremente una aprobada, y la
   * anterior (`approved`) sigue usándose hasta que se apruebe la nueva.
   */
  async update(id: string, body: Record<string, any>) {
    const t = await this.get(id);
    const contentChanged = CONTENT_FIELDS.some(
      (k) =>
        body?.[k] !== undefined &&
        JSON.stringify(body[k]) !== JSON.stringify((t as any)[k]),
    );
    if (body.label !== undefined) t.label = String(body.label);
    if (body.body !== undefined) t.body = String(body.body);
    if (body.footer !== undefined) t.footer = String(body.footer);
    if (Array.isArray(body.buttons)) t.buttons = body.buttons;
    if (body.category === 'UTILITY' || body.category === 'MARKETING') {
      t.category = body.category;
    }
    if (contentChanged && t.meta_status !== 'DRAFT') {
      t.version += 1;
      t.meta_status = 'DRAFT';
      t.meta_id = null;
      t.meta_name = null;
      t.meta_category = null;
      t.rejected_reason = null;
      t.submitted_at = null;
    }
    await t.save();
    return t;
  }

  async remove(id: string) {
    const t = await this.get(id);
    if (DEFAULT_TEMPLATES.some((d) => d.key === t.key)) {
      throw new BadRequestException(
        'Las plantillas del flujo base no se borran; puedes quitarlas del flujo',
      );
    }
    await t.deleteOne();
    return { deleted: true };
  }

  /** Envía la plantilla a revisión de Meta. */
  async submit(id: string) {
    const t = await this.get(id);
    if (t.meta_status !== 'DRAFT' && t.meta_status !== 'REJECTED') {
      throw new BadRequestException(
        'La plantilla ya está en Meta. Edítala para crear una versión nueva.',
      );
    }
    const errors = validateTemplate(t);
    if (errors.length) throw new BadRequestException(errors.join(' '));
    if (!this.gateway.hasTemplateApi) {
      throw new BadRequestException(
        'Faltan WHATSAPP_GATEWAY_URL o WHATSAPP_GATEWAY_API_KEY en el servidor',
      );
    }

    // Un rechazo no deja reutilizar el nombre: se sube de versión
    if (t.meta_status === 'REJECTED') t.version += 1;
    const metaName = `genon_${t.key}_v${t.version}`.slice(0, 512);
    const { payload, variables } = buildMetaTemplate(t, metaName, baseUrl());
    let res: { id?: string; status?: string; category?: string };
    try {
      res = await this.gateway.createTemplate(payload);
    } catch (error) {
      const data = (error as any)?.response?.data;
      throw new BadGatewayException(
        `Meta rechazó la plantilla: ${data?.details || data?.error || (error as Error).message}`,
      );
    }
    t.meta_name = metaName;
    t.meta_id = res.id || null;
    t.meta_status = (String(res.status || 'PENDING').toUpperCase() as any) || 'PENDING';
    t.meta_category = res.category || t.category;
    t.meta_variables = variables;
    t.rejected_reason = null;
    t.submitted_at = new Date();
    if (t.meta_status === 'APPROVED') this.markApproved(t);
    await t.save();
    return t;
  }

  /** Trae de Meta el estado, la categoría y el motivo de rechazo. */
  async sync() {
    if (!this.gateway.hasTemplateApi) {
      throw new BadRequestException(
        'Faltan WHATSAPP_GATEWAY_URL o WHATSAPP_GATEWAY_API_KEY en el servidor',
      );
    }
    const remote = await this.gateway.listTemplates();
    const byName = new Map(remote.map((r) => [`${r.name}:${r.language}`, r]));
    const local = await this.templateModel
      .find({ meta_name: { $ne: null } })
      .exec();
    let updated = 0;
    for (const t of local) {
      const r = byName.get(`${t.meta_name}:${t.language}`);
      if (!r) continue;
      t.meta_status = String(r.status).toUpperCase() as any;
      t.meta_id = r.id;
      t.meta_category = r.category;
      t.rejected_reason =
        r.rejected_reason && r.rejected_reason !== 'NONE'
          ? r.rejected_reason
          : null;
      t.synced_at = new Date();
      if (t.meta_status === 'APPROVED') this.markApproved(t);
      await t.save();
      updated++;
    }
    return { updated, total: local.length };
  }

  /** La versión en revisión pasa a ser la que se envía. */
  private markApproved(t: GenOnTemplate) {
    if (t.approved?.meta_name === t.meta_name) return;
    t.approved = {
      meta_name: t.meta_name!,
      language: t.language,
      body: t.body,
      variables: t.meta_variables,
      buttons: t.buttons,
      version: t.version,
      approved_at: new Date(),
    };
  }
}
