import { Module, forwardRef } from '@nestjs/common';
import { ProjectsService } from './projects.service.js';
import { ProjectsController } from './projects.controller.js';
import { AgentsModule } from '../agents/agents.module.js';

@Module({
  imports: [forwardRef(() => AgentsModule)],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
