import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from './schemas/user.schema';
import admin from 'src/firebase-admin';

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private userModel: Model<User>) {}

  async createOrUpdateUser(
    uid: string,
    name: string,
    email: string,
    phone?: string,
  ): Promise<User> {
    // Busca si ya existe usuario con ese firebase_uid
    const existingUser = await this.userModel.findOne({ uid }).exec();
    if (existingUser) {
      // Actualiza
      existingUser.names = name;
      existingUser.email = email;
      if (phone) {
        existingUser.phone = phone;
      }
      return existingUser.save();
    } else {
      // Crea
      const newUser = new this.userModel({ uid, names: name, email, phone });
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

  async findByPhone(phone: string): Promise<User | null> {
    return this.userModel.findOne({ phone }).exec();
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

  async changePasswordByUid(uid: string, newPassword: string) {
    // Cambia la contraseña de cualquier usuario
    await admin.auth().updateUser(uid, { password: newPassword });
    return { success: true, message: 'Contraseña cambiada correctamente' };
  }

  // Si solo tienes el correo:
  async changePasswordByEmail(email: string, newPassword: string) {
    const user = await admin.auth().getUserByEmail(email);
    return this.changePasswordByUid(user.uid, newPassword);
  }
}
