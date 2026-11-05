import { GUARDS_METADATA } from '@nestjs/common/constants.js'
import { ExecutionContext, ForbiddenException } from '@nestjs/common'
import { AgentAdminController } from './agent-admin.controller.js'
import { SystemAdminGuard } from '../auth/guards/system-admin.guard.js'

// Approval is what lets uploaded code run in the cluster, so only system
// admins may review agents. This pins the guard on the whole controller.
describe('AgentAdminController access', () => {
  it('is guarded by SystemAdminGuard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AgentAdminController) ?? []
    expect(guards).toContain(SystemAdminGuard)
  })

  const ctx = (user: unknown) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext

  it('turns away a regular user approving their own upload', () => {
    expect(() => new SystemAdminGuard().canActivate(ctx({ id: 'u1', isSystemAdmin: false }))).toThrow(
      ForbiddenException,
    )
  })

  it('lets a system admin through', () => {
    expect(new SystemAdminGuard().canActivate(ctx({ id: 'a1', isSystemAdmin: true }))).toBe(true)
  })
})
