import { Module } from '@nestjs/common';
import { StateMachineService } from './state-machine.service.js';
import { StateMachineGrpcController } from './state-machine-grpc.controller.js';
import { PrismaModule } from '../prisma/prisma.module.js';

@Module({
  imports: [PrismaModule],
  controllers: [StateMachineGrpcController],
  providers: [StateMachineService],
  exports: [StateMachineService],
})
export class StateMachineModule {}
