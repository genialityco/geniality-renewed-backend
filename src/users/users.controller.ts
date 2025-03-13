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
    const { firebase_uid, name, email } = body;
    if (!firebase_uid || !name || !email) {
      throw new NotFoundException('Faltan datos: firebase_uid, name, email');
    }
    return this.usersService.createOrUpdateUser(firebase_uid, name, email);
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
