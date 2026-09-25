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
import { PersonasService } from './personas.service';
import { CreatePersonaDto } from './dto/create-persona.dto';
import { UpdatePersonaDto } from './dto/update-persona.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('personas')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class PersonasController {
  constructor(private readonly personasService: PersonasService) {}

  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreatePersonaDto) {
    return this.personasService.create(user.userId, dto);
  }

  @Get()
  findAll(@CurrentUser() user: any) {
    return this.personasService.findAllForUser(user.userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.personasService.findOne(id, user.userId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdatePersonaDto,
  ) {
    return this.personasService.update(id, user.userId, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.personasService.remove(id, user.userId);
  }

  @Post(':id/duplicate')
  duplicate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.personasService.duplicate(id, user.userId);
  }
}
