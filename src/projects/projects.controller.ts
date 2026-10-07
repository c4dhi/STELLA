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
import { ConfigService } from '@nestjs/config';
import { ProjectsService } from './projects.service.js';
import { CreateProjectDto } from './dto/create-project.dto.js';
import { UpdateProjectDto } from './dto/update-project.dto.js';
import { UpdatePublicConfigDto } from './dto/update-public-config.dto.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';

@Controller('projects')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly configService: ConfigService,
  ) {}

  @Post()
  create(
    @Body() createProjectDto: CreateProjectDto,
    @CurrentUser() user: any,
  ) {
    return this.projectsService.create(createProjectDto, user.userId);
  }

  @Get()
  findAll(@CurrentUser() user: any) {
    return this.projectsService.findAll(user.userId);
  }

  @Get(':projectId')
  findOne(@Param('projectId') id: string) {
    return this.projectsService.findOne(id);
  }

  @Get(':projectId/stats')
  getStats(@Param('projectId') id: string) {
    return this.projectsService.getStats(id);
  }

  @Patch(':projectId')
  update(
    @Param('projectId') id: string,
    @Body() updateProjectDto: UpdateProjectDto,
  ) {
    return this.projectsService.update(id, updateProjectDto);
  }

  @Delete(':projectId')
  remove(@Param('projectId') id: string) {
    return this.projectsService.remove(id);
  }

  /**
   * Update public project configuration
   */
  @Patch(':projectId/public-config')
  updatePublicConfig(
    @Param('projectId') id: string,
    @Body() dto: UpdatePublicConfigDto,
  ) {
    return this.projectsService.updatePublicConfig(id, dto);
  }

  /**
   * Get public link for a project
   */
  @Get(':projectId/public-link')
  getPublicLink(@Param('projectId') id: string) {
    const baseUrl = this.configService.get<string>('PUBLIC_FRONTEND_URL') || 'http://localhost:8080';
    return this.projectsService.getPublicLink(id, baseUrl);
  }
}
