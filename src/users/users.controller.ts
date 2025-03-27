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
    const { uid, name, email } = body;
    if (!uid || !email) {
      throw new NotFoundException('Faltan datos: uid, name, email');
    }
    return this.usersService.createOrUpdateUser(uid, name, email);
  }

  @Get('/firebase/:uid')
  async getUserByFirebaseUid(@Param('uid') uid: string): Promise<User> {
    return this.usersService.findByFirebaseUid(uid);
  }

  @Get(':id')
  async getUserById(@Param('id') id: string): Promise<User> {
    return this.usersService.findById(id);
  }

  @Get()
  async findAll(): Promise<User[]> {
    return this.usersService.findAll();
  }
}
