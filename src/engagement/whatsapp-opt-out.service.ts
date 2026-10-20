import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { OrganizationUser } from 'src/organization-users/schemas/organization-user.schema';
import { User } from 'src/users/schemas/user.schema';
import { resolvePhone } from 'src/reminders/contact.util';

/** Regex que encuentra los dígitos aunque el campo tenga espacios o guiones. */
function looseDigitsRegex(digits: string): RegExp {
  return new RegExp(digits.split('').join('\\D*'));
}

/**
 * Baja de WhatsApp por número: la usa la entrada de mensajes cuando alguien
 * responde BAJA fuera de un simulacro (p. ej. a un recordatorio). Da de baja
 * todas las membresías cuyo teléfono resuelto (el mismo al que se envían los
 * mensajes) coincide con el número, en cualquier organización.
 */
@Injectable()
export class WhatsappOptOutService {
  private readonly logger = new Logger(WhatsappOptOutService.name);

  constructor(
    @InjectModel(OrganizationUser.name)
    private readonly organizationUserModel: Model<OrganizationUser>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
  ) {}

  /** Devuelve cuántas membresías quedaron dadas de baja (0 = número ajeno). */
  async optOutByPhone(phone: string): Promise<number> {
    const digits = String(phone ?? '').replace(/\D/g, '');
    if (digits.length < 7) return 0;

    const ids = await this.findMembershipIds(digits);
    if (!ids.length) return 0;

    const now = new Date();
    await this.organizationUserModel.collection.updateMany(
      { _id: { $in: ids } },
      { $set: { whatsapp_opt_in: false, whatsapp_opt_in_at: null } },
    );
    // Se conserva la fecha de la primera baja
    await this.organizationUserModel.collection.updateMany(
      { _id: { $in: ids }, whatsapp_opt_out_at: null },
      { $set: { whatsapp_opt_out_at: now } },
    );
    this.logger.log(`Baja de WhatsApp de ${phone}: ${ids.length} membresías`);
    return ids.length;
  }

  private async findMembershipIds(digits: string): Promise<Types.ObjectId[]> {
    // Se filtra en BD por los últimos 7 dígitos y se confirma con
    // resolvePhone (que antepone el indicativo de país).
    const tail = looseDigitsRegex(digits.slice(-7));
    const projection = {
      user_id: 1,
      'properties.phone': 1,
      'properties.indicativodepais': 1,
    };

    const byOwnPhone = await this.organizationUserModel.collection
      .find({ 'properties.phone': { $regex: tail } }, { projection })
      .toArray();
    const ids = byOwnPhone
      .filter((o: any) => resolvePhone(o, null) === digits)
      .map((o: any) => o._id);

    // Membresías sin teléfono propio usan el de users como respaldo
    const users = await this.userModel.collection
      .find({ phone: { $regex: tail } }, { projection: { phone: 1 } })
      .toArray();
    const matchingUsers = users.filter(
      (u: any) => String(u.phone ?? '').replace(/\D/g, '') === digits,
    );
    if (matchingUsers.length) {
      const userVals = matchingUsers.flatMap((u: any) => [u._id, String(u._id)]);
      const memberships = await this.organizationUserModel.collection
        .find({ user_id: { $in: userVals } }, { projection })
        .toArray();
      const userById = new Map(matchingUsers.map((u: any) => [String(u._id), u]));
      for (const o of memberships as any[]) {
        if (resolvePhone(o, userById.get(String(o.user_id))) === digits) {
          ids.push(o._id);
        }
      }
    }

    const seen = new Set<string>();
    return ids.filter((id) => {
      const key = String(id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
