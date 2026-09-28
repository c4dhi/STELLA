import { Module } from '@nestjs/common';
import { PlanTemplatesService } from './plan-templates.service.js';
import { PlanTemplatesController } from './plan-templates.controller.js';
import { PlanGeneratorService } from './plan-generator.service.js';

@Module({
  controllers: [PlanTemplatesController],
  providers: [PlanTemplatesService, PlanGeneratorService],
  exports: [PlanTemplatesService],
})
export class PlanTemplatesModule {}
