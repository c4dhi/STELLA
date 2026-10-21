import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { OAuthAuthorizationService } from './oauth-authorization.service.js';
import { OAuthTokensService } from './oauth-tokens.service.js';
import { ApproveRequestDto } from './dto/approve-request.dto.js';

function userIdOf(user: any): string {
  // Participant tokens pass the global guard too; only signed-in users can connect apps.
  if (!user?.userId) throw new ForbiddenException('Sign in to STELLA to connect an app');
  return user.userId;
}

/**
 * The signed-in user's side of MCP sign-in: the consent page and Settings →
 * MCP Access → Connected apps. Normal JWT-authenticated routes.
 */
@Controller()
export class OAuthConsentController {
  constructor(
    private readonly authorization: OAuthAuthorizationService,
    private readonly tokens: OAuthTokensService,
  ) {}

  @Get('oauth/requests/:id')
  view(@Param('id') id: string, @CurrentUser() user: any) {
    userIdOf(user);
    return this.authorization.view(id);
  }

  @Post('oauth/requests/:id/approve')
  @HttpCode(200)
  approve(@Param('id') id: string, @CurrentUser() user: any, @Body() dto: ApproveRequestDto) {
    return this.authorization.approve(id, userIdOf(user), dto.access);
  }

  @Post('oauth/requests/:id/deny')
  @HttpCode(200)
  deny(@Param('id') id: string, @CurrentUser() user: any) {
    return this.authorization.deny(id, userIdOf(user));
  }

  @Get('me/connected-apps')
  connectedApps(@CurrentUser() user: any) {
    return this.tokens.listConnectedApps(userIdOf(user));
  }

  @Delete('me/connected-apps/:id')
  @HttpCode(204)
  async disconnect(@Param('id') id: string, @CurrentUser() user: any) {
    await this.tokens.disconnect(id, userIdOf(user));
  }
}
