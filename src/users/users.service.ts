// users.service.ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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

  // ===== CAMBIAR CONTRASEÑA =====
  async changePasswordByUid(uid: string, newPassword: string) {
    if (!newPassword || newPassword.trim().length < 6) {
      throw new BadRequestException(
        'La contraseña debe tener al menos 6 caracteres.',
      );
    }
    await admin.auth().updateUser(uid, { password: newPassword.trim() });
    return { success: true, message: 'Contraseña cambiada correctamente' };
  }

  async changePasswordByEmail(email: string, newPassword: string) {
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail) throw new BadRequestException('Email requerido.');
    const user = await admin
      .auth()
      .getUserByEmail(cleanEmail)
      .catch(() => null);
    if (!user)
      throw new NotFoundException(
        'No existe un usuario con ese email en Firebase.',
      );
    return this.changePasswordByUid(user.uid, newPassword);
  }

  // ===== CAMBIAR EMAIL =====
  async changeEmailByUid(uid: string, newEmail: string) {
    const cleanEmail = (newEmail || '').trim().toLowerCase();
    if (!cleanEmail) throw new BadRequestException('Nuevo email requerido.');

    // 1) Actualiza en Firebase
    const updated = await admin.auth().updateUser(uid, { email: cleanEmail });

    // 2) Sincroniza en Mongo si existe
    const userDoc = await this.userModel.findOne({ uid }).exec();
    if (userDoc) {
      userDoc.email = cleanEmail;
      await userDoc.save();
    }

    return {
      success: true,
      message: 'Email actualizado correctamente',
      uid: updated.uid,
      email: cleanEmail,
    };
  }

  async changeEmailByCurrentEmail(currentEmail: string, newEmail: string) {
    const cleanCurrent = (currentEmail || '').trim().toLowerCase();
    const user = await admin
      .auth()
      .getUserByEmail(cleanCurrent)
      .catch(() => null);
    if (!user)
      throw new NotFoundException(
        'No existe un usuario con ese email en Firebase.',
      );
    return this.changeEmailByUid(user.uid, newEmail);
  }

  // ===== CAMBIAR AMBOS (EMAIL y/o PASSWORD) =====
  /**
   * Cambia email y/o password en Firebase y sincroniza Mongo.
   * Cualquier campo es opcional, pero al menos uno debe venir.
   */
  async changeCredentials(opts: {
    uid?: string;
    currentEmail?: string;
    newEmail?: string;
    newPassword?: string;
  }) {
    const { uid, currentEmail, newEmail, newPassword } = opts;

    if (!newEmail && !newPassword) {
      throw new BadRequestException('Debes enviar newEmail y/o newPassword.');
    }

    let targetUid = uid;

    if (!targetUid && currentEmail) {
      const user = await admin
        .auth()
        .getUserByEmail(currentEmail.trim().toLowerCase())
        .catch(() => null);
      if (!user)
        throw new NotFoundException(
          'No existe un usuario con ese email en Firebase.',
        );
      targetUid = user.uid;
    }

    if (!targetUid) {
      throw new BadRequestException('Debes enviar uid o currentEmail.');
    }

    const update: admin.auth.UpdateRequest = {};
    if (newEmail) update.email = newEmail.trim().toLowerCase();
    if (newPassword) {
      if (newPassword.trim().length < 6) {
        throw new BadRequestException(
          'La contraseña debe tener al menos 6 caracteres.',
        );
      }
      update.password = newPassword.trim();
    }

    const updated = await admin.auth().updateUser(targetUid, update);

    // Sincroniza email en Mongo si cambió
    if (newEmail) {
      const userDoc = await this.userModel.findOne({ uid: targetUid }).exec();
      if (userDoc) {
        userDoc.email = newEmail.trim().toLowerCase();
        await userDoc.save();
      }
    }

    return {
      success: true,
      message: 'Credenciales actualizadas correctamente',
      uid: updated.uid,
      email: updated.email,
    };
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
