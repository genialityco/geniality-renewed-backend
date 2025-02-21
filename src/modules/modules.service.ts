import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Module } from './schemas/module.schema';

@Injectable()
export class ModulesService {
  constructor(
    @InjectModel('Module') private readonly moduleModel: Model<Module>,
  ) {}

  async create(module: Module): Promise<Module> {
    const newModule = new this.moduleModel(module);
    return newModule.save();
  }

  async findAll(): Promise<Module[]> {
    return this.moduleModel.find().exec();
  }

  async findOne(id: string): Promise<Module> {
    return this.moduleModel.findById(id).exec();
  }

  async update(id: string, module: Module): Promise<Module> {
    return this.moduleModel.findByIdAndUpdate(id, module, { new: true }).exec();
  }

  async delete(id: string): Promise<Module> {
    return this.moduleModel.findByIdAndDelete(id).exec();
  }

  async findByEventId(event_id: string): Promise<Module[]> {
    return this.moduleModel.find({ event_id }).exec();
  }
}
