import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ValidationPipe,
  UsePipes,
} from '@nestjs/common';
import { EnvVarTemplatesService } from './env-var-templates.service.js';
import { CreateEnvVarTemplateDto } from './dto/create-env-var-template.dto.js';
import { UpdateEnvVarTemplateDto } from './dto/update-env-var-template.dto.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';

@Controller('env-var-templates')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class EnvVarTemplatesController {
  constructor(
    private readonly envVarTemplatesService: EnvVarTemplatesService,
  ) {}

  /**
   * Create a new environment variable template
   */
  @Post()
  create(
    @CurrentUser() user: any,
    @Body() dto: CreateEnvVarTemplateDto,
  ) {
    return this.envVarTemplatesService.create(user.userId, dto);
  }

  /**
   * Get environment variable templates for the current user.
   *
   * - With `agentTypeId`: returns ONLY templates scoped to that type (strict).
   *   Type-aware flows (deploy/project/configurator) MUST pass `agentTypeId`.
   * - Without `agentTypeId`: returns all of the user's templates across types,
   *   for the settings management page only.
   */
  @Get()
  findAll(
    @CurrentUser() user: any,
    @Query('agentTypeId') agentTypeId?: string,
  ) {
    if (agentTypeId) {
      return this.envVarTemplatesService.findByAgentType(
        user.userId,
        agentTypeId,
      );
    }
    return this.envVarTemplatesService.findAllByUser(user.userId);
  }

  /**
   * Get a single environment variable template by ID
   */
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.envVarTemplatesService.findOne(id, user.userId);
  }

  /**
   * Update an environment variable template
   */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateEnvVarTemplateDto,
  ) {
    return this.envVarTemplatesService.update(id, user.userId, dto);
  }

  /**
   * Delete an environment variable template
   */
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.envVarTemplatesService.remove(id, user.userId);
  }

  /**
   * Duplicate an environment variable template
   */
  @Post(':id/duplicate')
  duplicate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.envVarTemplatesService.duplicate(id, user.userId);
  }
}
