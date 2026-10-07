import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { InvitationsService } from './invitations.service.js';
import { CreateInvitationDto } from './dto/create-invitation.dto.js';
import { AcceptInvitationDto } from './dto/accept-invitation.dto.js';
import { Public } from '../common/decorators/public.decorator.js';

@Controller()
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  // ============================================================================
  // Authenticated Endpoints (for organizers)
  // ============================================================================

  /**
   * Create a new invitation for a session
   * POST /sessions/:sessionId/invitations
   */
  @Post('sessions/:sessionId/invitations')
  create(
    @Param('sessionId') sessionId: string,
    @Body() createInvitationDto: CreateInvitationDto,
  ) {
    return this.invitationsService.create(sessionId, createInvitationDto);
  }

  /**
   * List all invitations for a session
   * GET /sessions/:sessionId/invitations
   */
  @Get('sessions/:sessionId/invitations')
  findBySession(@Param('sessionId') sessionId: string) {
    return this.invitationsService.findBySession(sessionId);
  }

  /**
   * Get invitation details by ID
   * GET /invitations/:invitationId
   */
  @Get('invitations/:invitationId')
  findOne(@Param('invitationId') invitationId: string) {
    return this.invitationsService.findOne(invitationId);
  }

  /**
   * Revoke an invitation (changes status to REVOKED)
   * DELETE /invitations/:invitationId/revoke
   */
  @Delete('invitations/:invitationId/revoke')
  revoke(@Param('invitationId') invitationId: string) {
    return this.invitationsService.revoke(invitationId);
  }

  /**
   * Permanently delete an invitation
   * DELETE /invitations/:invitationId
   */
  @Delete('invitations/:invitationId')
  delete(@Param('invitationId') invitationId: string) {
    return this.invitationsService.delete(invitationId);
  }

  // ============================================================================
  // Public Endpoints (for participants)
  // ============================================================================

  /**
   * Get invitation details by token (public)
   * GET /join/:token
   */
  @Public()
  @Get('join/:token')
  getByToken(@Param('token') token: string) {
    return this.invitationsService.getByToken(token);
  }

  /**
   * Accept an invitation and get connection info (public)
   * POST /join/:token/accept
   */
  @Public()
  @Post('join/:token/accept')
  accept(
    @Param('token') token: string,
    @Body() acceptInvitationDto: AcceptInvitationDto,
  ) {
    return this.invitationsService.accept(token, acceptInvitationDto);
  }

  /**
   * Rejoin an already accepted invitation (public)
   * POST /join/:token/rejoin
   */
  @Public()
  @Post('join/:token/rejoin')
  rejoin(@Param('token') token: string) {
    return this.invitationsService.rejoin(token);
  }
}
