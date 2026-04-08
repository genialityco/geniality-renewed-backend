import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CompletionMessage, CompletionMessageType } from './schemas/completion-message.schema';

@Injectable()
export class CompletionMessagesService {
  constructor(
    @InjectModel(CompletionMessage.name)
    private completionMessageModel: Model<CompletionMessage>,
  ) {}

  async create(data: {
    organization_id: string;
    blocks: any[];
    type?: CompletionMessageType;
    active?: boolean;
    order?: number;
  }): Promise<CompletionMessage> {
    const newMessage = new this.completionMessageModel({
      ...data,
      organization_id: new Types.ObjectId(data.organization_id),
      type: data.type || CompletionMessageType.MODULO_PROGRESO,
    });
    return newMessage.save();
  }

  async findByOrganization(organizationId: string): Promise<CompletionMessage[]> {
    return this.completionMessageModel
      .find({
        organization_id: new Types.ObjectId(organizationId),
        active: true,
      })
      .sort({ type: 1, order: 1 })
      .exec();
  }

  async findByOrganizationAndType(
    organizationId: string,
    type: CompletionMessageType,
  ): Promise<CompletionMessage[]> {
    return this.completionMessageModel
      .find({
        organization_id: new Types.ObjectId(organizationId),
        type,
        active: true,
      })
      .sort({ order: 1 })
      .exec();
  }

  async findOne(id: string): Promise<CompletionMessage> {
    const message = await this.completionMessageModel.findById(id).exec();
    if (!message) throw new NotFoundException('Completion message not found');
    return message;
  }

  async update(
    id: string,
    data: Partial<CompletionMessage>,
  ): Promise<CompletionMessage> {
    return this.completionMessageModel
      .findByIdAndUpdate(id, data, { new: true })
      .exec();
  }

  async delete(id: string): Promise<void> {
    await this.completionMessageModel.findByIdAndDelete(id).exec();
  }

  async deleteByOrganization(organizationId: string): Promise<void> {
    await this.completionMessageModel
      .deleteMany({
        organization_id: new Types.ObjectId(organizationId),
      })
      .exec();
  }
}
