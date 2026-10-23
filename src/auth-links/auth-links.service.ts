import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash, randomBytes } from 'crypto';
import * as admin from 'firebase-admin';
import { User } from 'src/users/schemas/user.schema';
import { UsersService } from 'src/users/users.service';
import { OrganizationUser } from 'src/organization-users/schemas/organization-user.schema';
import { Organization } from 'src/organizations/schemas/organization.schema';
import { AuthLink } from './auth-link.schema';

const DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN_ROLES = ['admin', 'owner', 'super_admin'];
// Parámetro de la URL que el frontend canjea al cargar cualquier página
export const LOGIN_PARAM = 'login';

/** Mensaje de WhatsApp: texto o interactivo con cuerpo (ver OutboundMessage). */
type Message = string | { body: string; [key: string]: any };

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

const idVariants = (id: unknown): any[] => {
  const raw = String(id);
  return Types.ObjectId.isValid(raw) && String(new Types.ObjectId(raw)) === raw
    ? [raw, new Types.ObjectId(raw)]
    : [raw];
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const appBaseUrl = () =>
  (process.env.WHATSAPP_REMINDER_BASE_URL || 'https://app.geniality.com.co').replace(/\/+$/, '');

/**
 * Enlaces de acceso directo: la persona toca el enlace de un mensaje y entra
 * a la plataforma ya autenticada, en la página del enlace (y en el minuto del
 * video si trae ?t=). Valen AUTH_LINK_TTL_DAYS días (7 por defecto) y se
 * pueden usar varias veces. Nunca se emiten para administradores ni autores
 * de una organización: con su enlace se entraría a la administración.
 */
@Injectable()
export class AuthLinksService {
  private readonly logger = new Logger(AuthLinksService.name);

  constructor(
    @InjectModel(AuthLink.name) private readonly linkModel: Model<AuthLink>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(OrganizationUser.name)
    private readonly organizationUserModel: Model<OrganizationUser>,
    @InjectModel(Organization.name)
    private readonly organizationModel: Model<Organization>,
    private readonly usersService: UsersService,
  ) {}

  private get ttlMs(): number {
    const days = Number(process.env.AUTH_LINK_TTL_DAYS);
    return (Number.isFinite(days) && days > 0 ? days : 7) * DAY_MS;
  }

  /** Token nuevo para la persona, o null si no se le puede dar (admin, sin membresía). */
  async create(userId: string, organizationId: string, source: string): Promise<string | null> {
    try {
      if (!(await this.eligible(userId, organizationId))) return null;
      const token = randomBytes(24).toString('base64url');
      await this.linkModel.create({
        token_hash: hash(token),
        user_id: String(userId),
        organization_id: String(organizationId),
        source,
        expires_at: new Date(Date.now() + this.ttlMs),
      });
      return token;
    } catch (error) {
      // Sin enlace directo el mensaje sigue saliendo con el enlace normal
      this.logger.warn(`No se pudo crear el enlace de acceso: ${(error as Error).message}`);
      return null;
    }
  }

  /** La URL (o sufijo de URL) con el parámetro de acceso; conserva ?t=, ?ref= y el #. */
  static withToken(url: string, token: string): string {
    const [base, ...fragment] = url.split('#');
    const joined = `${base}${base.includes('?') ? '&' : '?'}${LOGIN_PARAM}=${token}`;
    return fragment.length ? `${joined}#${fragment.join('#')}` : joined;
  }

  /** Enlaces de la plataforma de esa organización dentro de un texto. */
  private linkPattern(organizationId: string): RegExp {
    return new RegExp(
      `${escapeRegExp(appBaseUrl())}/organization/${escapeRegExp(String(organizationId))}(?:/[^\\s)\\]>*_]*)?`,
      'g',
    );
  }

  /** Agrega el acceso directo a los enlaces de la plataforma en un texto. */
  addToText(text: string, organizationId: string, token: string): string {
    return text.replace(this.linkPattern(organizationId), (url) =>
      AuthLinksService.withToken(url, token),
    );
  }

  /**
   * Agrega el acceso directo a los enlaces de la plataforma de esa
   * organización que aparezcan en los mensajes. Un solo token para todos; si
   * no hay enlaces o no se puede dar acceso, los devuelve tal cual.
   */
  async addToMessages<T extends Message>(
    messages: T[],
    userId: string,
    organizationId: string,
    source: string,
  ): Promise<T[]> {
    const bodyOf = (m: Message) => (typeof m === 'string' ? m : m?.body || '');
    const re = this.linkPattern(organizationId);
    if (!messages.some((m) => bodyOf(m).search(re) >= 0)) return messages;
    const token = await this.create(userId, organizationId, source);
    if (!token) return messages;
    return messages.map((m) =>
      typeof m === 'string'
        ? (this.addToText(m, organizationId, token) as T)
        : ({
            ...(m as Exclude<Message, string>),
            body: this.addToText(m.body || '', organizationId, token),
          } as T),
    );
  }

  /**
   * Canjea el token: devuelve un token de Firebase para iniciar sesión y un
   * token de sesión de la plataforma. Valida vigencia y membresía al usarlo.
   */
  async redeem(token: string) {
    const link = token ? await this.linkModel.findOne({ token_hash: hash(token) }).exec() : null;
    if (!link || link.expires_at.getTime() <= Date.now()) {
      throw new UnauthorizedException('El enlace venció o no es válido. Inicia sesión.');
    }
    if (!(await this.eligible(link.user_id, link.organization_id))) {
      throw new UnauthorizedException('El enlace ya no es válido. Inicia sesión.');
    }
    const user = Types.ObjectId.isValid(link.user_id)
      ? await this.userModel.findById(link.user_id).select('uid').lean().exec()
      : null;
    if (!user?.uid) throw new UnauthorizedException('El enlace no es válido. Inicia sesión.');

    const customToken = await admin.auth().createCustomToken(String(user.uid));
    const { sessionToken, user: fullUser } = await this.usersService.updateSessionToken(
      String(user.uid),
    );
    await this.linkModel
      .updateOne({ _id: link._id }, { $inc: { uses: 1 }, $set: { last_used_at: new Date() } })
      .exec();
    const u: any = fullUser;
    return {
      customToken,
      sessionToken,
      organizationId: link.organization_id,
      // Sin los demás tokens de sesión ni la contraseña
      user: { _id: String(u._id), uid: u.uid, names: u.names, email: u.email, phone: u.phone },
    };
  }

  /** Miembro de la organización y sin rol administrativo en ninguna. */
  private async eligible(userId: string, organizationId: string): Promise<boolean> {
    const [membership, memberships, authored] = await Promise.all([
      this.organizationUserModel.collection.findOne(
        {
          user_id: { $in: idVariants(userId) },
          organization_id: { $in: idVariants(organizationId) },
        },
        { projection: { _id: 1 } },
      ),
      this.organizationUserModel.collection
        .find({ user_id: { $in: idVariants(userId) } }, { projection: { rol_id: 1 } })
        .toArray(),
      this.organizationModel.collection.findOne(
        { author: { $in: idVariants(userId) } },
        { projection: { _id: 1 } },
      ),
    ]);
    if (!membership || authored) return false;
    return !memberships.some((m: any) =>
      ADMIN_ROLES.includes(String(m.rol_id || '').toLowerCase()),
    );
  }
}
