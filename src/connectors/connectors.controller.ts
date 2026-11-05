import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { ConnectorsService } from './connectors.service.js';
import { CreateConnectorDto, UpdateConnectorDto } from './dto/connector.dto.js';

/**
 * Settings → Connectors: outside MCP servers the user's agents may call.
 * STELLA is the client here; /me/access-tokens is the opposite direction.
 * No response ever contains the credential.
 */
@Controller('me/connectors')
export class ConnectorsController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Get()
  list(@CurrentUser() user: any) {
    return this.connectors.list(this.userIdOf(user));
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: any) {
    return this.connectors.get(id, this.userIdOf(user));
  }

  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreateConnectorDto) {
    return this.connectors.create(this.userIdOf(user), dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @CurrentUser() user: any, @Body() dto: UpdateConnectorDto) {
    return this.connectors.update(id, this.userIdOf(user), dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.connectors.remove(id, this.userIdOf(user));
  }

  /** MCP initialize + tools/list against the server; stores the tool list. */
  @Post(':id/test')
  test(@Param('id') id: string, @CurrentUser() user: any) {
    return this.connectors.test(id, this.userIdOf(user));
  }

  // Participant tokens pass the global guard too; they own no connectors.
  private userIdOf(user: any): string {
    if (!user?.userId) throw new ForbiddenException('Only signed-in users have connectors');
    return user.userId;
  }
}
