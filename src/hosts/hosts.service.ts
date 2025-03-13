import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Host } from './schemas/host.schema';

@Injectable()
export class HostsService {
  constructor(@InjectModel(Host.name) private hostModel: Model<Host>) {}

  async create(createHost: any): Promise<Host> {
    const createdHost = new this.hostModel(createHost);
    return createdHost.save();
  }

  async findAll(): Promise<Host[]> {
    return this.hostModel.find().exec();
  }

  async findOne(id: string): Promise<Host> {
    const host = await this.hostModel.findById(id).exec();
    if (!host) {
      throw new NotFoundException(`Host con id ${id} no encontrado`);
    }
    return host;
  }

  async update(id: string, updateHost: any): Promise<Host> {
    const updatedHost = await this.hostModel
      .findByIdAndUpdate(id, updateHost, { new: true })
      .exec();
    if (!updatedHost) {
      throw new NotFoundException(`Host con id ${id} no encontrado`);
    }
    return updatedHost;
  }

  async remove(id: string): Promise<Host> {
    const deletedHost = await this.hostModel.findByIdAndDelete(id).exec();
    if (!deletedHost) {
      throw new NotFoundException(`Host con id ${id} no encontrado`);
    }
    return deletedHost;
  }
}
