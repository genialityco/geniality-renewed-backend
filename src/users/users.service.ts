import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from './schemas/user.schema';

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private userModel: Model<User>) {}

  async createOrUpdateUser(
    uid: string,
    name: string,
    email: string,
  ): Promise<User> {
    // Busca si ya existe usuario con ese firebase_uid
    const existingUser = await this.userModel.findOne({ uid }).exec();
    if (existingUser) {
      // Actualiza
      existingUser.names = name;
      existingUser.email = email;
      return existingUser.save();
    } else {
      // Crea
      const newUser = new this.userModel({ uid, names: name, email });
      return newUser.save();
    }
  }

  async findByFirebaseUid(uid: string): Promise<User> {
    const user = await this.userModel.findOne({ uid }).exec();
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    return user;
  }

  async findById(id: string): Promise<User> {
    const user = await this.userModel.findById(id).exec();
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    return user;
  }

  async findAll(): Promise<User[]> {
    return this.userModel.find().exec();
  }
}
