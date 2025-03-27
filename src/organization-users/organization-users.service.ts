// organization-users.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OrganizationUser } from './schemas/organization-user.schema';

@Injectable()
export class OrganizationUsersService {
  constructor(
    @InjectModel(OrganizationUser.name)
    private organizationUserModel: Model<OrganizationUser>,
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
      return existingUser.save();
    }
    const newUser = new this.organizationUserModel({
      properties,
      rol_id,
      organization_id,
      user_id,
      payment_plan_id,
    });
    return newUser.save();
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
}
