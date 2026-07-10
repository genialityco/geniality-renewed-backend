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

/**
 * Aislamiento entre organizaciones a nivel de API.
 *
 * Los guards del frontend evitan la navegación por UI, pero no impiden que
 * alguien llame la API directamente. Este guard exige que el usuario
 * autenticado (uid en `x-uid`) sea MIEMBRO de la organización cuyo id viene
 * en la ruta (`:organizationId` / `:orgId`). Si no pertenece, responde 403.
 *
 * Pensado para combinarse con `SessionTokenGuard`
 * (`@UseGuards(SessionTokenGuard, OrgMembershipGuard)`): primero se valida la
 * sesión y luego la pertenencia a la organización.
 *
 * Consulta el modelo `OrganizationUser` directamente (en vez de depender de
 * `OrganizationUsersService`) para no arrastrar el módulo de organization-users
 * ni su ciclo con payment-plans a cada módulo que use este guard.
 */
@Injectable()
export class OrgMembershipGuard implements CanActivate {
  constructor(
    private readonly usersService: UsersService,
    @InjectModel(OrganizationUser.name)
    private readonly organizationUserModel: Model<OrganizationUser>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();

    // Permitir preflight CORS
    if (req.method === 'OPTIONS') return true;

    const uid: string | undefined =
      (req.auth?.uid as string) ||
      (req.user?.uid as string) ||
      (req.headers['x-uid'] as string) ||
      (req.headers['x_uid'] as string);

    const organizationId: string | undefined =
      req.params?.organizationId || req.params?.orgId;

    if (!uid) {
      throw new UnauthorizedException('No autenticado');
    }
    if (!organizationId) {
      // Sin organización en la ruta no hay nada que aislar; deja pasar para
      // no romper endpoints donde este guard no aplique por error de montaje.
      return true;
    }

    // Resolver el User a partir del uid de Firebase.
    let user: { _id: any } | null = null;
    try {
      user = await this.usersService.findByFirebaseUid(String(uid));
    } catch {
      user = null;
    }
    if (!user?._id) {
      throw new UnauthorizedException('No autenticado');
    }

    // organization_id / user_id pueden estar guardados como string u ObjectId
    // según cómo se insertó el registro; se contemplan ambas formas.
    const orgIdVariants: any[] = [String(organizationId)];
    const userIdVariants: any[] = [String(user._id)];
    if (Types.ObjectId.isValid(organizationId)) {
      orgIdVariants.push(new Types.ObjectId(String(organizationId)));
    }
    if (Types.ObjectId.isValid(String(user._id))) {
      userIdVariants.push(new Types.ObjectId(String(user._id)));
    }

    const membership = await this.organizationUserModel
      .findOne({
        user_id: { $in: userIdVariants },
        organization_id: { $in: orgIdVariants },
      })
      .exec();

    if (!membership) {
      throw new ForbiddenException('No perteneces a esta organización');
    }

    return true;
  }
}
