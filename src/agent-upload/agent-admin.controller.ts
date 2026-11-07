import { Controller, Post, Get, Param, Body, Req, UseGuards } from '@nestjs/common'
import { Request } from 'express'
import { SystemAdminGuard } from '../auth/guards/system-admin.guard.js'
import { AgentReviewService } from './agent-review.service.js'

interface AuthenticatedRequest extends Request {
  user: { userId: string; email: string }
}

interface ApproveDto {
  notes?: string
}

interface RejectDto {
  reason: string
}

// Approving an agent lets its uploaded code run in the cluster (see
// assertDeployableAgentType), so review is for system admins only. Without
// this guard any signed-in user could approve their own upload.
@Controller('admin/agent-types')
@UseGuards(SystemAdminGuard)
export class AgentAdminController {
  constructor(private readonly review: AgentReviewService) {}

  /** GET /admin/agent-types/pending: uploads waiting for review, oldest first. */
  @Get('pending')
  getPendingAgents() {
    return this.review.list('pending')
  }

  /** GET /admin/agent-types/status/:status (pending, approved or rejected). */
  @Get('status/:status')
  getAgentsByStatus(@Param('status') status: string) {
    return this.review.list(status)
  }

  /** POST /admin/agent-types/:id/approve, with optional notes. */
  @Post(':id/approve')
  approveAgent(@Param('id') id: string, @Body() dto: ApproveDto, @Req() req: AuthenticatedRequest) {
    return this.review.approve(id, req.user.userId, dto?.notes)
  }

  /** POST /admin/agent-types/:id/reject, with a required reason. */
  @Post(':id/reject')
  rejectAgent(@Param('id') id: string, @Body() dto: RejectDto, @Req() req: AuthenticatedRequest) {
    return this.review.reject(id, req.user.userId, dto?.reason ?? '')
  }

  /** GET /admin/agent-types/:id: everything a reviewer looks at. */
  @Get(':id')
  getAgentDetails(@Param('id') id: string) {
    return this.review.get(id)
  }
}
