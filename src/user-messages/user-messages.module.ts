import { Module } from '@nestjs/common';
import { UserMessagesService } from './user-messages.service.js';
import { UserMessagesController } from './user-messages.controller.js';
import { PrismaModule } from '../prisma/prisma.module.js';

@Module({
  imports: [PrismaModule],
  controllers: [UserMessagesController],
  providers: [UserMessagesService],
  exports: [UserMessagesService],
})
export class UserMessagesModule {}
