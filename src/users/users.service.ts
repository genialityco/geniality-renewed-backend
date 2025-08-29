// users.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
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
    const existingUser = await this.userModel.findOne({ uid }).exec();
    if (existingUser) {
      existingUser.names = name;
      existingUser.email = email;
      if (phone) existingUser.phone = phone;
      // Asegura que exista el arreglo:
      if (!Array.isArray(existingUser.sessionTokens))
        existingUser.sessionTokens = [];
      return existingUser.save();
    } else {
      const newUser = new this.userModel({
        uid,
        names: name,
        email,
        phone,
        sessionTokens: [],
      });
      return newUser.save();
    }
  }

  async findByFirebaseUid(uid: string): Promise<User> {
    const user = await this.userModel.findOne({ uid }).exec();
    if (!user) throw new NotFoundException('Usuario no encontrado');
    // Asegura consistencia:
    if (!Array.isArray(user.sessionTokens)) user.sessionTokens = [];
    return user;
  }

  async findByPhone(phone: string): Promise<User | null> {
    return this.userModel.findOne({ phone }).exec();
  }

  async findById(id: string): Promise<User> {
    const user = await this.userModel.findById(id).exec();
    if (!user) throw new NotFoundException('Usuario no encontrado');
    if (!Array.isArray(user.sessionTokens)) user.sessionTokens = [];
    return user;
  }

  async findAll(): Promise<User[]> {
    return this.userModel.find().exec();
  }

  async changePasswordByUid(uid: string, newPassword: string) {
    await admin.auth().updateUser(uid, { password: newPassword });
    return { success: true, message: 'Contraseña cambiada correctamente' };
  }

  async changePasswordByEmail(email: string, newPassword: string) {
    const user = await admin.auth().getUserByEmail(email);
    return this.changePasswordByUid(user.uid, newPassword);
  }

  /**
   * Genera un token, lo agrega a la lista y recorta a los 2 más recientes.
   * Devuelve el token generado, además del documento de usuario.
   */
  async updateSessionToken(
    uid: string,
  ): Promise<{ sessionToken: string; user: User }> {
    const newToken = uuidv4();

    const user = await this.userModel.findOneAndUpdate(
      { uid },
      {
        $push: {
          sessionTokens: {
            $each: [{ token: newToken, createdAt: new Date() }],
            $slice: -2, // Mantiene solo los 2 últimos
          },
        },
        // (Opcional) Limpia el legacy field si existiera:
        $unset: { sessionToken: '' },
      },
      { new: true },
    );

    if (!user) throw new NotFoundException('Usuario no encontrado');

    return { sessionToken: newToken, user };
  }
}
