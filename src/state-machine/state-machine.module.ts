import { Module } from '@nestjs/common';
import { StateMachineService } from './state-machine.service.js';
import { StateMachineGrpcController } from './state-machine-grpc.controller.js';
import { CapabilitiesService } from './capabilities.service.js';
import { CAPABILITIES_PROVIDER } from './capabilities.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ConnectorsModule } from '../connectors/connectors.module.js';

@Module({
  imports: [PrismaModule, ConnectorsModule],
  controllers: [StateMachineGrpcController],
  providers: [
    StateMachineService,
    CapabilitiesService,
    { provide: CAPABILITIES_PROVIDER, useExisting: CapabilitiesService },
  ],
  exports: [StateMachineService],
})
export class StateMachineModule {}
