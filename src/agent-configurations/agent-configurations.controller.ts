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
import { AgentConfigurationsService } from './agent-configurations.service.js';
import { CreateAgentConfigurationDto } from './dto/create-agent-configuration.dto.js';
import { UpdateAgentConfigurationDto } from './dto/update-agent-configuration.dto.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';

@Controller('agent-configurations')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class AgentConfigurationsController {
  constructor(
    private readonly agentConfigurationsService: AgentConfigurationsService,
  ) {}

  @Post()
  create(
    @CurrentUser() user: any,
    @Body() dto: CreateAgentConfigurationDto,
  ) {
    return this.agentConfigurationsService.create(user.userId, dto);
  }

  @Get()
  findAll(
    @CurrentUser() user: any,
    @Query('agentTypeId') agentTypeId?: string,
  ) {
    return this.agentConfigurationsService.findAllByUser(user.userId, agentTypeId);
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.agentConfigurationsService.findOne(id, user.userId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateAgentConfigurationDto,
  ) {
    return this.agentConfigurationsService.update(id, user.userId, dto);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.agentConfigurationsService.remove(id, user.userId);
  }

  @Post(':id/duplicate')
  duplicate(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.agentConfigurationsService.duplicate(id, user.userId);
  }
}
