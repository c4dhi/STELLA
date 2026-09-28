import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ValidationPipe,
  UsePipes,
} from '@nestjs/common';
import { PlanTemplatesService } from './plan-templates.service.js';
import { PlanGeneratorService } from './plan-generator.service.js';
import { CreatePlanTemplateDto } from './dto/create-plan-template.dto.js';
import { UpdatePlanTemplateDto } from './dto/update-plan-template.dto.js';
import { GeneratePlanTemplateDto } from './dto/generate-plan-template.dto.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';

@Controller('plan-templates')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class PlanTemplatesController {
  constructor(
    private readonly planTemplatesService: PlanTemplatesService,
    private readonly planGeneratorService: PlanGeneratorService,
  ) {}

  @Post()
  create(
    @CurrentUser() user: any,
    @Body() dto: CreatePlanTemplateDto,
  ) {
    return this.planTemplatesService.create(user.userId, dto);
  }

  @Post('generate')
  generate(@Body() dto: GeneratePlanTemplateDto) {
    return this.planGeneratorService.generate(dto);
  }

  @Get()
  findAll(@CurrentUser() user: any) {
    return this.planTemplatesService.findAllByUser(user.userId);
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.planTemplatesService.findOne(id, user.userId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdatePlanTemplateDto,
  ) {
    return this.planTemplatesService.update(id, user.userId, dto);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.planTemplatesService.remove(id, user.userId);
  }

  @Post(':id/duplicate')
  duplicate(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.planTemplatesService.duplicate(id, user.userId);
  }
}
