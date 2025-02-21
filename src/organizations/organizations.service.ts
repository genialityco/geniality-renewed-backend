import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Organization } from './schemas/organization.schema';

@Injectable()
export class OrganizationsService {
  constructor(
    @InjectModel(Organization.name) private orgModel: Model<Organization>,
  ) {}

  async create(data: Partial<Organization>): Promise<Organization> {
    const newOrg = new this.orgModel(data);
    return newOrg.save();
  }

  async findAll(): Promise<Organization[]> {
    return this.orgModel.find().exec();
  }

  async findOne(id: string): Promise<Organization> {
    const organization = await this.orgModel.findById(id).exec();
    if (!organization) throw new NotFoundException('Organization not found');
    return organization;
  }

  async update(id: string, data: Partial<Organization>): Promise<Organization> {
    return this.orgModel.findByIdAndUpdate(id, data, { new: true }).exec();
  }

  async delete(id: string): Promise<void> {
    await this.orgModel.findByIdAndDelete(id).exec();
  }
}
