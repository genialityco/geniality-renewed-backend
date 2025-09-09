// organization-users.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OrganizationUser } from './schemas/organization-user.schema';
import { EmailService } from 'src/email/email.service';
import { buildAccountEmailHtml } from 'src/templates/account-email.template';

@Injectable()
export class OrganizationUsersService {
  constructor(
    @InjectModel(OrganizationUser.name)
    private organizationUserModel: Model<OrganizationUser>,
    private readonly emailService: EmailService,
  ) { }

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
      const toEmail =
        properties?.email ||
        saved?.properties?.email ||
        null;
      if (toEmail) {
        const subject = 'Tu cuenta en EndoCampus fue actualizada';
        const html = buildAccountEmailHtml('actualizada', saved.properties.nombres);
        // no bloquear la respuesta si el email falla
        this.sendEmailSafely(toEmail, subject, html);
      }
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
    const toEmail =
      properties?.email ||
      saved?.properties?.email ||
      null;
    if (toEmail) {
      const subject = '¡Bienvenido! Tu cuenta en EndoCampus fue creada';
      const html = buildAccountEmailHtml('creada',saved.properties.nombres);
      this.sendEmailSafely(toEmail, subject, html);
    }
    return saved;
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
    search?: string, // <--- Añadido
  ): Promise<{ results: OrganizationUser[]; total: number }> {
    const skip = (page - 1) * limit;

    // Armar filtro base
    const filter: any = { organization_id };

    // Si hay search, buscar en properties.email, properties.name, properties.names
    if (search && search.trim() !== '') {
      filter.$or = [
        { 'properties.email': { $regex: search, $options: 'i' } },
        { 'properties.name': { $regex: search, $options: 'i' } },
        { 'properties.names': { $regex: search, $options: 'i' } },
      ];
    }

    const [results, total] = await Promise.all([
      this.organizationUserModel
        .find(filter)
        .skip(skip)
        .limit(limit)
        .populate('payment_plan_id') // <--- Poblamos el payment_plan_id
        .exec(),
      this.organizationUserModel.countDocuments(filter),
    ]);
    return { results, total };
  }

  async findByEmail(email: string): Promise<OrganizationUser | null> {
    return this.organizationUserModel
      .findOne({ 'properties.email': email })
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

  private async sendEmailSafely(to: string, subject: string, html: string) {
    try {
      await this.emailService.sendEmail(to, subject, html);
    } catch (err: any) {
      console.log(`No se pudo enviar email a ${to}: ${err?.message || err}`);
    }
  }

}
