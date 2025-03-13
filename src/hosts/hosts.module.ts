import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HostsController } from './hosts.controller';
import { HostsService } from './hosts.service';
import { Host, HostSchema } from './schemas/host.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Host.name, schema: HostSchema }]),
  ],
  controllers: [HostsController],
  providers: [HostsService],
})
export class HostsModule {}
