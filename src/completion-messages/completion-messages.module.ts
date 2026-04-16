import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  CompletionMessage,
  CompletionMessageSchema,
} from './schemas/completion-message.schema';
import { CompletionMessagesService } from './completion-messages.service';
import { CompletionMessagesController } from './completion-messages.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CompletionMessage.name, schema: CompletionMessageSchema },
    ]),
  ],
  providers: [CompletionMessagesService],
  controllers: [CompletionMessagesController],
  exports: [CompletionMessagesService],
})
export class CompletionMessagesModule {}
