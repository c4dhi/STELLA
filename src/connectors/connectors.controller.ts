import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { ConnectorsService } from './connectors.service.js';
import {
  CallConnectorToolDto,
  CreateConnectorDto,
  SetConnectorSharesDto,
  UpdateConnectorDto,
} from './dto/connector.dto.js';

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

  /**
   * What the user may bind when deploying in a project: their own connectors
   * plus those shared with it. Declared before :id so "available" is not an id.
   */
  @Get('available')
  available(@Query('projectId') projectId: string, @CurrentUser() user: any) {
    if (!projectId) throw new BadRequestException('projectId is required');
    return this.connectors.listAvailable(this.userIdOf(user), projectId);
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
  update(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateConnectorDto,
  ) {
    return this.connectors.update(id, this.userIdOf(user), dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.connectors.remove(id, this.userIdOf(user));
  }

  /** Replace the projects this connector is shared with. Owner only. */
  @Put(':id/shares')
  setShares(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: SetConnectorSharesDto,
  ) {
    return this.connectors.setShares(id, this.userIdOf(user), dto.projectIds);
  }

  /** MCP initialize + tools/list against the server; stores the tool list. */
  @Post(':id/test')
  test(@Param('id') id: string, @CurrentUser() user: any) {
    return this.connectors.test(id, this.userIdOf(user));
  }

  /** Run one tool with the given arguments, as the owner. For "Try it". */
  @Post(':id/tools/:tool/call')
  callTool(
    @Param('id') id: string,
    @Param('tool') tool: string,
    @CurrentUser() user: any,
    @Body() dto: CallConnectorToolDto,
  ) {
    return this.connectors.callTool(
      id,
      this.userIdOf(user),
      tool,
      dto.arguments,
    );
  }

  /** The latest outbound calls (tests, agents' tool calls), newest first. */
  @Get(':id/calls')
  recentCalls(
    @Param('id') id: string,
    @Query('limit') limit: string | undefined,
    @CurrentUser() user: any,
  ) {
    const n = limit ? Number.parseInt(limit, 10) : undefined;
    return this.connectors.recentCalls(
      id,
      this.userIdOf(user),
      Number.isFinite(n) ? n : undefined,
    );
  }

  // Participant tokens pass the global guard too; they own no connectors.
  private userIdOf(user: any): string {
    if (!user?.userId)
      throw new ForbiddenException('Only signed-in users have connectors');
    return user.userId;
  }
}
