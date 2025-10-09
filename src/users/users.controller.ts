// users.controller.ts
import {
  Controller,
  Get,
  Param,
  Post,
  Body,
  NotFoundException,
  BadRequestException,
  UseGuards,
  Req,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { User } from './schemas/user.schema';
import { SessionTokenGuard } from 'src/auth/session-token.guard';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  async createOrUpdateUser(@Body() body: any): Promise<User> {
    const { uid, name, names, email, phone, password } = body;
    const finalName = names ?? name;
    if (!uid || !email || !finalName) {
      throw new BadRequestException('Faltan datos: uid, names, email');
    }
    return this.usersService.createOrUpdateUser(
      uid,
      finalName,
      email,
      phone,
      password,
    );
  }

  @Post(':id/delete')
  async deleteById(@Param('id') id: string) {
    await this.usersService.deleteUserByID(id);
    return { message: 'Usuario eliminado' };
  }

  @Post('/refresh-session')
  async refreshSessionToken(@Body() body: any) {
    if (!body?.uid) throw new BadRequestException('uid requerido');
    return this.usersService.updateSessionToken(body.uid); // => { sessionToken, user }
  }

  @Get('/firebase/:uid')
  async getUserByFirebaseUid(@Param('uid') uid: string): Promise<User> {
    return this.usersService.findByFirebaseUid(uid);
  }

  @Get('/phone/:phone')
  async getUserByPhone(@Param('phone') phone: string): Promise<User | null> {
    const user = await this.usersService.findByPhone(phone);
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return user;
  }

  @Get(':id')
  async getUserById(@Param('id') id: string): Promise<User> {
    return this.usersService.findById(id);
  }

  @Get()
  async findAll(): Promise<User[]> {
    return this.usersService.findAll();
  }

  // ===== Password =====
  @Post('change-password') // espera { userId, newPassword }
  async changePassword(@Body() body: any) {
    const { userId, newPassword } = body || {};
    if (!userId) throw new BadRequestException('userId requerido');
    return this.usersService.changePasswordByUserId(userId, newPassword);
  }

  // Legacy (por email)
  @Post('change-password-by-email') // { email, newPassword }
  async changePasswordByEmail(@Body() body: any) {
    const { email, newPassword } = body || {};
    if (!email) throw new BadRequestException('email requerido');
    return this.usersService.changePasswordByEmail(email, newPassword);
  }

  // ===== Email =====
  @Post('change-email-by-userid')
  async changeEmailByUserId(@Body() body: any) {
    const { userId, newEmail } = body || {};
    if (!userId) throw new BadRequestException('userId requerido');
    if (!newEmail) throw new BadRequestException('newEmail requerido');
    return this.usersService.changeEmailByUserId(userId, newEmail);
  }

  // Legacy (por email actual)
  @Post('change-email-by-email') // { currentEmail, newEmail }
  async changeEmailByEmail(@Body() body: any) {
    const { currentEmail, newEmail } = body || {};
    if (!currentEmail) throw new BadRequestException('currentEmail requerido');
    if (!newEmail) throw new BadRequestException('newEmail requerido');
    return this.usersService.changeEmailByCurrentEmail(currentEmail, newEmail);
  }

  // ===== Ambos (email y/o password) =====
  @Post('change-credentials')
  async changeCredentials(@Body() body: any) {
    // Admite { userId } o { uid } o { currentEmail } + { newEmail/newPassword }
    const { newEmail, newPassword } = body || {};
    if (!newEmail && !newPassword) {
      throw new BadRequestException('Debes enviar newEmail y/o newPassword.');
    }
    return this.usersService.changeCredentials(body);
  }

  // ===== Logout (revocar token de sesión) =====
  @UseGuards(SessionTokenGuard)
  @Post('logout')
  async logout(@Req() req: any, @Body() body: any) {
    const uid = req.auth?.uid ?? body?.uid;
    const token = req.auth?.sessionToken ?? body?.sessionToken;
    if (!uid || !token) {
      throw new BadRequestException('Faltan uid o sessionToken.');
    }
    await this.usersService.revokeSessionToken(String(uid), String(token));
    return { success: true };
  }
}
