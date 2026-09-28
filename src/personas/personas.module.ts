import { Module } from '@nestjs/common';
import { PersonasService } from './personas.service.js';
import { PersonasController } from './personas.controller.js';

@Module({
  controllers: [PersonasController],
  providers: [PersonasService],
  exports: [PersonasService],
})
export class PersonasModule {}
