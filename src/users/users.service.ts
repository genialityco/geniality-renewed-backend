import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from './schemas/user.schema';

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private userModel: Model<User>) {}

  async createOrUpdateUser(
    firebase_uid: string,
    name: string,
    email: string,
  ): Promise<User> {
    // Busca si ya existe usuario con ese firebase_uid
    const existingUser = await this.userModel.findOne({ firebase_uid }).exec();
    if (existingUser) {
      // Actualiza
      existingUser.name = name;
      existingUser.email = email;
      return existingUser.save();
    } else {
      // Crea
      const newUser = new this.userModel({ firebase_uid, name, email });
      return newUser.save();
    }
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
