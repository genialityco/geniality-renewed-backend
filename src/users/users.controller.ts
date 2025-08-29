// users.controller.ts
import {
  Controller,
  Get,
  Param,
  Post,
  Body,
  NotFoundException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { User } from './schemas/user.schema';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  async createOrUpdateUser(@Body() body: any): Promise<User> {
    const { uid, name, email, phone } = body;
    if (!uid || !email) {
      throw new NotFoundException('Faltan datos: uid, name, email');
    }
    return this.usersService.createOrUpdateUser(uid, name, email, phone);
  }

  @Post('/refresh-session')
  async refreshSessionToken(@Body() body: { uid: string }) {
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

  @Post('change-password')
  async changePassword(@Body() body: { uid: string; newPassword: string }) {
    return this.usersService.changePasswordByUid(body.uid, body.newPassword);
  }

  @Post('change-password-by-email')
  async changePasswordByEmail(
    @Body() body: { email: string; newPassword: string },
  ) {
    return this.usersService.changePasswordByEmail(
      body.email,
      body.newPassword,
    );
  }
}
