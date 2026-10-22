import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { AccessTokensService } from './access-tokens.service.js';
import { CreateAccessTokenDto } from './dto/create-access-token.dto.js';

/** Settings → MCP access: the signed-in user's own personal access tokens. */
@Controller('me/access-tokens')
export class AccessTokensController {
  constructor(private readonly accessTokens: AccessTokensService) {}

  @Get()
  list(@CurrentUser() user: any) {
    return this.accessTokens.list(this.userIdOf(user));
  }

  /** The response is the only time the secret is ever shown. */
  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreateAccessTokenDto) {
    return this.accessTokens.create(this.userIdOf(user), dto);
  }

  @Delete(':id')
  revoke(@Param('id') id: string, @CurrentUser() user: any) {
    return this.accessTokens.revoke(id, this.userIdOf(user));
  }

  // Participant tokens pass the global guard too; they own no tokens.
  private userIdOf(user: any): string {
    if (!user?.userId)
      throw new ForbiddenException('Only signed-in users have access tokens');
    return user.userId;
  }
}
