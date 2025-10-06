// organization-users.service.ts
import {
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { OrganizationUser } from './schemas/organization-user.schema';
import { EmailService } from 'src/email/email.service';
import { renderWelcomeContent } from '../templates/Welcome';
import { PaymentPlansService } from 'src/payment-plans/payment-plans.service';
import { UsersService } from 'src/users/users.service';
function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
@Injectable()
export class OrganizationUsersService {
  constructor(
    @InjectModel(OrganizationUser.name)
    private organizationUserModel: Model<OrganizationUser>,
    @Inject(forwardRef(() => PaymentPlansService))
    private readonly paymentPlansService: PaymentPlansService,
    private readonly emailService: EmailService,
    private readonly usersService: UsersService,
  ) {}

  async createOrUpdateUser(
    properties: any,
    rol_id: string,
    organization_id: string,
    user_id: string,
    payment_plan_id?: string,
  ): Promise<OrganizationUser> {
    const existingUser = await this.organizationUserModel
      .findOne({ user_id })
      .exec();
    if (existingUser) {
      existingUser.properties = properties;
      existingUser.rol_id = rol_id;
      existingUser.organization_id = organization_id;
      if (payment_plan_id) {
        existingUser.payment_plan_id = payment_plan_id;
      }
      const saved = await existingUser.save();
      // Email destino (prioriza el que llega en properties)
      // const toEmail =
      //   properties?.email ||
      //   saved?.properties?.email ||
      //   null;
      // if (toEmail) {
      //   const subject = `${saved?.properties?.nombres}, tu cuenta en EndoCampus fue actualizada`;
      //   const html = renderWelcomeContent(saved?.properties?.nombres, URL);
      //   // no bloquear la respuesta si el email falla
      //   this.sendEmailSafely(toEmail, subject, html, saved.organization_id);
      // }
      return saved;
    }
    // -------- crear --------
    const newUser = new this.organizationUserModel({
      properties,
      rol_id,
      organization_id,
      user_id,
      payment_plan_id,
    });
    const saved = await newUser.save();
    const toEmail = properties?.email || saved?.properties?.email || null;
    if (toEmail) {
      const subject = `${saved?.properties?.nombres}, tu cuenta en EndoCampus fue creada`;
      const contentHtml = renderWelcomeContent(saved?.properties?.nombres);
      const organizationUserId = String(saved._id);
      await this.emailService.sendLayoutEmail(
        toEmail,
        subject,
        contentHtml,
        organizationUserId,
      );
    }
    return saved;
  }

  async deleteOrganizationUser(user_id: string): Promise<void> {
    const user = await this.findByUserId(user_id);
    if (!user) {
      console.log(
        'No se encontró el usuario de la organización con user_id:',
        user_id,
      );
      throw new NotFoundException('Organization user not found');
    }
    const paymentID = user.payment_plan_id;
    const User_id = user.user_id;
    if (paymentID) {
      await this.paymentPlansService.deletePaymentPlan(paymentID);
    }
    await this.usersService.deleteUserByID(User_id);
    await this.organizationUserModel.deleteOne({ user_id }).exec();
  }

  async findByUserId(user_id: string): Promise<OrganizationUser> {
    const user = await this.organizationUserModel.findOne({ user_id }).exec();
    if (!user) {
      throw new NotFoundException('Organization user not found');
    }
    return user;
  }

  // Nuevo método para actualizar el payment_plan_id del OrganizationUser
  async updatePaymentPlanId(
    user_id: string,
    payment_plan_id: string,
  ): Promise<OrganizationUser> {
    const user = await this.organizationUserModel
      .findOneAndUpdate({ user_id }, { payment_plan_id }, { new: true })
      .exec();
    if (!user) {
      throw new NotFoundException('Organization user not found');
    }
    return user;
  }

  async findByOrganizationId(
    organization_id: string,
    page = 1,
    limit = 20,
    search?: string,
  ): Promise<{ results: OrganizationUser[]; total: number }> {
    const skip = (page - 1) * limit;

    // Armar filtro base con campos obligatorios
    const filter: any = {
      organization_id,
      // 🔥 Filtrar usuarios que tengan ID, email y phone
      'properties.ID': { $exists: true, $nin: [null, ''] },
      'properties.email': { $exists: true, $nin: [null, ''] },
      'properties.phone': { $exists: true, $nin: [null, ''] },
    };

    // Si hay search, buscar en properties.email, properties.name, properties.names
    if (search && search.trim() !== '') {
      filter.$or = [
        { 'properties.email': { $regex: search, $options: 'i' } },
        { 'properties.name': { $regex: search, $options: 'i' } },
        { 'properties.names': { $regex: search, $options: 'i' } },
        { 'properties.nombres': { $regex: search, $options: 'i' } },
        { 'properties.ID': { $regex: search, $options: 'i' } },
        { 'properties.phone': { $regex: search, $options: 'i' } }, // 🔥 Añadido phone al search
      ];
    }

    const [results, total] = await Promise.all([
      this.organizationUserModel
        .find(filter)
        .skip(skip)
        .sort({ created_at: -1 })
        .limit(limit)
        .populate('payment_plan_id')
        .exec(),
      this.organizationUserModel.countDocuments(filter),
    ]);
    return { results, total };
  }

  async findByEmail(email: string): Promise<OrganizationUser | null> {
    const pattern = `^${escapeRegex(email)}$`;
    return this.organizationUserModel
      .findOne({ 'properties.email': { $regex: pattern, $options: 'i' } })
      .exec();
  }

  async findAllByOrganizationId(
    organization_id: string,
    search?: string,
  ): Promise<OrganizationUser[]> {
    // Armar el filtro
    const filter: any = { organization_id };
    if (search && search.trim() !== '') {
      filter.$or = [
        { 'properties.email': { $regex: search, $options: 'i' } },
        { 'properties.name': { $regex: search, $options: 'i' } },
        { 'properties.names': { $regex: search, $options: 'i' } },
      ];
    }

    // Devolver todos los resultados sin paginación
    return this.organizationUserModel
      .find(filter)
      .populate('payment_plan_id')
      .exec();
  }

  async recoverPassword(email: string): Promise<void> {
    try {
      const user = await this.findByEmail(email);
      if (!user) {
        throw new NotFoundException('User not found');
      }
      await this.emailService.sendLayoutEmail(
        email,
        'Recuperación de contraseña',
        `<p>Las credenciales para ingresar son:</p>
        \n<strong>Email: ${user.properties.email}</strong>\n<strong>ID: ${user.properties.ID}</strong>\n
        Por favor, utiliza estos datos para iniciar sesión\n
        Si deseas cambiar tu contraseña, puedes hacerlo desde el siguiente link.
        <a href="https://app.geniality.com.co/organization/${user.organization_id}/recuperar-datos">Cambiar contraseña</a>`,
        user.organization_id,
      );
    } catch (error) {
      console.error('Error recovering password:', error);
      throw new NotFoundException('Error recovering password');
    }
  }

  async findOrganizationsByUserId(user_id: string) {
    if (!Types.ObjectId.isValid(user_id)) {
      throw new NotFoundException('Invalid user_id');
    }
    const uid = new Types.ObjectId(user_id);
    const rows = await this.organizationUserModel
      .find({ user_id: uid })
      .select('_id rol_id properties created_at updated_at organization_id')
      .populate({
        path: 'organization_id',
        select: 'name styles author updated_at created_at', // ajusta campos si quieres
      })
      .lean()
      .exec();
    const mapped = rows.map((r) => ({
      organization: r.organization_id, // doc poblado
      membership: {
        _id: String(r._id),
        rol_id: r.rol_id ?? null,
        properties: r.properties,
      },
    }));
    return mapped;
  }
}
