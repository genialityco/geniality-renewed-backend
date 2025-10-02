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

type TokenEntry = { token: string; createdAt: Date };

function normalizeTokens(arr: any[]): TokenEntry[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((e) =>
      typeof e === 'string'
        ? { token: e, createdAt: new Date(0) }
        : { token: String(e?.token), createdAt: new Date(e?.createdAt ?? 0) },
    )
    .filter((e) => e.token);
}

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private userModel: Model<User>) {}

  // ========= Helper para obtener uid desde userId =========
  private async resolveUidByUserIdOrThrow(userId: string): Promise<string> {
    const doc = await this.userModel.findById(userId, { uid: 1 }).lean();
    if (!doc) {
      throw new NotFoundException(`No existe usuario con id ${userId}`);
    }
    const uid = (doc as any).uid;
    if (!uid) {
      throw new BadRequestException(
        `El usuario ${userId} no tiene vinculado un uid de Firebase.`,
      );
    }
    return uid;
  }

  // ========= Helpers por UID (reutilizables) =========
  private assertPasswordOk(password?: string) {
    if (!password || password.trim().length < 6) {
      throw new BadRequestException(
        'La contraseña debe tener al menos 6 caracteres.',
      );
    }
  }

  async changePasswordByUid(uid: string, newPassword: string) {
    this.assertPasswordOk(newPassword);
    await admin.auth().updateUser(uid, { password: newPassword.trim() });
    return { success: true, message: 'Contraseña cambiada correctamente' };
  }

  async changeEmailByUid(uid: string, newEmail: string) {
    const cleanEmail = (newEmail || '').trim().toLowerCase();
    if (!cleanEmail) throw new BadRequestException('Nuevo email requerido.');

    // Comprobar colisión de email
    const existing = await admin
      .auth()
      .getUserByEmail(cleanEmail)
      .catch(() => null);
    if (existing && existing.uid !== uid) {
      throw new BadRequestException(
        'Ese correo ya está en uso por otro usuario.',
      );
    }

    const updated = await admin.auth().updateUser(uid, { email: cleanEmail });

    // Sincroniza en Mongo si existe
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

  // ========= CRUD =========
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

  async deleteUserByID(
    user_id: string,
  ): Promise<{ authDeleted: boolean; mongoDeleted: boolean }> {
    if (!this.findById(user_id)) {
      throw new BadRequestException('user_id inválido');
    }
    // 1) Buscar el doc para obtener el uid de Firebase
    const user = await this.userModel
      .findById(user_id)
      .select({ uid: 1 })
      .lean();
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    let authDeleted = false;
    if (user.uid) {
      try {
        await admin.auth().deleteUser(user.uid);
        authDeleted = true;
      } catch (e: any) {
        // Si no existe en Firebase Auth lo puedes tratar como ya eliminado
        if (e?.code !== 'auth/user-not-found') {
          // si prefieres no interrumpir, puedes loguear y seguir
          throw e;
        }
      }
    }
    const res = await this.userModel.deleteOne({ _id: user_id }).exec();
    const mongoDeleted = res.deletedCount === 1;
    if (!mongoDeleted) {
      throw new NotFoundException(
        'No se pudo eliminar el documento de usuario',
      );
    }
    return { authDeleted, mongoDeleted };
  }

  async findByFirebaseUid(uid: string): Promise<User> {
    const user = await this.userModel.findOne({ uid }).exec();
    if (!user) throw new NotFoundException('Usuario no encontrado');
    if (!Array.isArray(user.sessionTokens)) user.sessionTokens = [];
    return user;
  }

  async findByPhone(phone: string): Promise<User | null> {
    return this.userModel.findOne({ phone }).exec();
  }

  async findTokensByUid(
    uid: string,
  ): Promise<{ sessionTokens: any[]; legacyToken?: string } | null> {
    const user = await this.userModel
      .findOne({ uid }, { sessionTokens: 1, sessionToken: 1, _id: 0 })
      .lean();
    if (!user) return null;
    return {
      sessionTokens: Array.isArray((user as any).sessionTokens)
        ? (user as any).sessionTokens
        : [],
      legacyToken: (user as any).sessionToken,
    };
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
  async changePasswordByUserId(userId: string, newPassword: string) {
    this.assertPasswordOk(newPassword);
    const uid = await this.resolveUidByUserIdOrThrow(userId);
    await admin.auth().updateUser(uid, { password: newPassword.trim() });
    return { success: true, message: 'Contraseña cambiada correctamente' };
  }

  // LEGACY por email
  async changePasswordByEmail(email: string, newPassword: string) {
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail) throw new BadRequestException('Email requerido.');
    const user = await admin
      .auth()
      .getUserByEmail(cleanEmail)
      .catch(() => null);
    if (!user) {
      throw new NotFoundException(
        'No existe un usuario con ese email en Firebase.',
      );
    }
    return this.changePasswordByUid(user.uid, newPassword);
  }

  // ===== CAMBIAR EMAIL =====
  async changeEmailByUserId(userId: string, newEmail: string) {
    const uid = await this.resolveUidByUserIdOrThrow(userId);
    return this.changeEmailByUid(uid, newEmail);
  }

  async changeEmailByCurrentEmail(currentEmail: string, newEmail: string) {
    const cleanCurrent = (currentEmail || '').trim().toLowerCase();
    const user = await admin
      .auth()
      .getUserByEmail(cleanCurrent)
      .catch(() => null);
    if (!user) {
      throw new NotFoundException(
        'No existe un usuario con ese email en Firebase.',
      );
    }
    return this.changeEmailByUid(user.uid, newEmail);
  }

  // ===== CAMBIAR AMBOS (EMAIL y/o PASSWORD) =====
  async changeCredentials(opts: {
    userId?: string; // <<<< NUEVO: permite venir userId
    uid?: string;
    currentEmail?: string;
    newEmail?: string;
    newPassword?: string;
  }) {
    const { userId, uid, currentEmail, newEmail, newPassword } = opts;

    if (!newEmail && !newPassword) {
      throw new BadRequestException('Debes enviar newEmail y/o newPassword.');
    }

    // Resolver uid con prioridad: userId -> uid -> currentEmail
    let targetUid = uid;
    if (userId) {
      targetUid = await this.resolveUidByUserIdOrThrow(userId);
    }
    if (!targetUid && currentEmail) {
      const fbUser = await admin
        .auth()
        .getUserByEmail(currentEmail.trim().toLowerCase())
        .catch(() => null);
      if (!fbUser)
        throw new NotFoundException(
          'No existe un usuario con ese email en Firebase.',
        );
      targetUid = fbUser.uid;
    }
    if (!targetUid) {
      throw new BadRequestException('Debes enviar userId, uid o currentEmail.');
    }

    const update: admin.auth.UpdateRequest = {};
    if (newEmail) {
      const cleanEmail = newEmail.trim().toLowerCase();
      if (!cleanEmail) throw new BadRequestException('Nuevo email requerido.');
      // Colisión
      const existing = await admin
        .auth()
        .getUserByEmail(cleanEmail)
        .catch(() => null);
      if (existing && existing.uid !== targetUid) {
        throw new BadRequestException(
          'Ese correo ya está en uso por otro usuario.',
        );
      }
      update.email = cleanEmail;
    }
    if (newPassword) {
      this.assertPasswordOk(newPassword);
      update.password = newPassword.trim();
    }

    const updated = await admin.auth().updateUser(targetUid, update);

    // Sincroniza email en Mongo si cambió
    if (update.email) {
      const userDoc = await this.userModel.findOne({ uid: targetUid }).exec();
      if (userDoc) {
        userDoc.email = update.email;
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
  ): Promise<{ sessionToken: string; user: User; revokedTokens: string[] }> {
    const newToken = uuidv4();

    const doc = await this.userModel
      .findOne({ uid }, { sessionTokens: 1 })
      .lean();
    if (!doc) throw new NotFoundException('Usuario no encontrado');

    const current = normalizeTokens((doc as any).sessionTokens);
    const next = [...current, { token: newToken, createdAt: new Date() }].sort(
      (a, b) => +a.createdAt - +b.createdAt,
    );

    const kept: TokenEntry[] = next.slice(-2);
    const keptSet = new Set(kept.map((e) => e.token));

    const revokedTokens = next
      .map((e) => e.token)
      .filter((t) => !keptSet.has(t));

    const saved = await this.userModel
      .findOneAndUpdate(
        { uid },
        { $set: { sessionTokens: kept }, $unset: { sessionToken: '' } },
        { new: true },
      )
      .exec();

    const rtdb = admin.database();
    await rtdb.ref(`sessions/${uid}/${newToken}`).set({
      createdAt: admin.database.ServerValue.TIMESTAMP,
    });
    await Promise.all(
      revokedTokens.map((t) => rtdb.ref(`sessions/${uid}/${t}`).remove()),
    );

    return { sessionToken: newToken, user: saved, revokedTokens };
  }

  async revokeSessionToken(uid: string, sessionToken: string) {
    await this.userModel.updateOne(
      { uid },
      { $pull: { sessionTokens: { token: sessionToken } } },
    );
    await admin.database().ref(`sessions/${uid}/${sessionToken}`).remove();
    return { success: true };
  }
}
