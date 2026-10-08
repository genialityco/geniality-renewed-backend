import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { UsersService } from 'src/users/users.service';
import { OrganizationUser } from 'src/organization-users/schemas/organization-user.schema';
import { Organization } from 'src/organizations/schemas/organization.schema';

const ADMIN_ROLES = ['admin', 'owner', 'super_admin'];

/**
 * Exige que el usuario autenticado sea ADMIN de la organización de la ruta
 * (`:organizationId` / `:orgId`): autor de la organización o rol_id
 * administrativo en su membresía. Misma regla que `utils/orgAccess.ts` del
 * frontend y `UsersService.isAdminUser`.
 *
 * Para endpoints que actúan sobre otros usuarios (p. ej. enviar un simulacro
 * por WhatsApp), donde OrgMembershipGuard no basta. Requiere los modelos
 * Organization y OrganizationUser registrados en el módulo, más UsersService.
 * Combinar con SessionTokenGuard: `@UseGuards(SessionTokenGuard, OrgAdminGuard)`.
 */
@Injectable()
export class OrgAdminGuard implements CanActivate {
  constructor(
    private readonly usersService: UsersService,
    @InjectModel(OrganizationUser.name)
    private readonly organizationUserModel: Model<OrganizationUser>,
    @InjectModel(Organization.name)
    private readonly organizationModel: Model<Organization>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    if (req.method === 'OPTIONS') return true;

    const uid: string | undefined =
      (req.auth?.uid as string) ||
      (req.user?.uid as string) ||
      (req.headers['x-uid'] as string);
    const organizationId: string | undefined =
      req.params?.organizationId || req.params?.orgId;

    if (!uid) throw new UnauthorizedException('No autenticado');
    if (!organizationId || !Types.ObjectId.isValid(organizationId)) {
      throw new ForbiddenException('Organización inválida');
    }

    let user: { _id: any } | null = null;
    try {
      user = await this.usersService.findByFirebaseUid(String(uid));
    } catch {
      user = null;
    }
    if (!user?._id) throw new UnauthorizedException('No autenticado');

    const orgObjectId = new Types.ObjectId(organizationId);
    const userIds: any[] = [String(user._id)];
    if (Types.ObjectId.isValid(String(user._id))) {
      userIds.push(new Types.ObjectId(String(user._id)));
    }

    const [authored, membership] = await Promise.all([
      this.organizationModel
        .exists({ _id: orgObjectId, author: { $in: userIds } })
        .exec(),
      this.organizationUserModel
        .findOne({
          user_id: { $in: userIds },
          organization_id: { $in: [organizationId, orgObjectId] },
        })
        .select('rol_id')
        .lean()
        .exec(),
    ]);
    const role = String((membership as any)?.rol_id || '').toLowerCase();
    if (authored || ADMIN_ROLES.includes(role)) return true;

    throw new ForbiddenException(
      'Necesitas ser administrador de esta organización',
    );
  }
}
