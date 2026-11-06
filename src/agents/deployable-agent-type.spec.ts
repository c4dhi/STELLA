import { BadRequestException } from '@nestjs/common';
import { AgentValidationStatus } from '@prisma/client';
import { CURRENT_SDK_VERSION, MIN_SUPPORTED_SDK_VERSION } from '../agent-package/manifest-defaults.js';
import { agentTypeAccessProblem, assertDeployableAgentType } from './deployable-agent-type.util.js';
import { isPodAlive } from './agents.service.js';

const { APPROVED, PENDING, REJECTED } = AgentValidationStatus;

describe('assertDeployableAgentType', () => {
  const builtIn = { isBuiltIn: true, validationStatus: APPROVED, imageUrl: null, userId: null, sdkVersion: null };
  const upload = {
    isBuiltIn: false, validationStatus: PENDING, imageUrl: 'elias-interviewer:0.1.0', userId: 'owner',
    sdkVersion: CURRENT_SDK_VERSION, projectShares: [{ projectId: 'shared' }],
  };
  const reviewOff = { reviewRequired: false };
  const reviewOn = { reviewRequired: true };

  const ok = (record: any, ctx: any) => expect(() => assertDeployableAgentType('x', record, ctx)).not.toThrow();
  const no = (record: any, ctx: any, msg: RegExp) =>
    expect(() => assertDeployableAgentType('x', record, ctx)).toThrow(msg);

  it('deploys an approved built-in for anyone, with or without review', () => {
    ok(builtIn, { ...reviewOff, deployerId: 'anyone', projectId: 'any' });
    ok(builtIn, { ...reviewOn, deployerId: 'anyone', projectId: 'any' });
  });

  describe('review off', () => {
    it('lets the owner deploy their upload in any project', () => {
      ok(upload, { ...reviewOff, deployerId: 'owner', projectId: 'mine' });
    });

    it('lets a member deploy it in a project the owner shared it with', () => {
      ok(upload, { ...reviewOff, deployerId: 'member', projectId: 'shared' });
    });

    it('refuses it anywhere else, approved or not', () => {
      no(upload, { ...reviewOff, deployerId: 'member', projectId: 'other' }, /not shared with this project/);
      no({ ...upload, validationStatus: APPROVED }, { ...reviewOff, deployerId: 'member', projectId: 'other' }, /not shared with this project/);
      no({ ...upload, projectShares: [] }, { ...reviewOff, deployerId: 'member', projectId: 'shared' }, /not shared/);
    });

    it('turns it away on a path with no user, unless shared with that project', () => {
      no(upload, { ...reviewOff, deployerId: null, projectId: 'other' }, /not shared with this project/);
      ok(upload, { ...reviewOff, deployerId: null, projectId: 'shared' });
    });

    it('lets a restart or wake of an existing instance through', () => {
      ok({ ...upload, projectShares: [] }, reviewOff);
    });
  });

  describe('review on', () => {
    it('makes even the uploader wait for an admin', () => {
      no(upload, { ...reviewOn, deployerId: 'owner', projectId: 'mine' }, /waiting for an admin/);
    });

    it('stops a restart or wake of an unreviewed upload', () => {
      no(upload, reviewOn, /waiting for an admin/);
    });

    it('lets an approved upload deploy for its owner and in shared projects only', () => {
      const approved = { ...upload, validationStatus: APPROVED };
      ok(approved, { ...reviewOn, deployerId: 'owner', projectId: 'mine' });
      ok(approved, { ...reviewOn, deployerId: 'member', projectId: 'shared' });
      no(approved, { ...reviewOn, deployerId: 'member', projectId: 'other' }, /not shared with this project/);
    });
  });

  describe('agentTypeAccessProblem (the agent lists)', () => {
    const see = (record: any, who: any) => agentTypeAccessProblem(record, { reviewRequired: false, ...who });

    it('shows an upload to its owner, and to members of a project it is shared with', () => {
      expect(see(upload, { userId: 'owner', memberOf: [] })).toBeNull();
      expect(see(upload, { userId: 'member', memberOf: ['x', 'shared'] })).toBeNull();
      expect(see(upload, { userId: 'member', memberOf: ['x'] })).toMatch(/not shared/);
    });

    it('narrows to one project when asked about it', () => {
      expect(see(upload, { userId: 'member', projectId: 'shared' })).toBeNull();
      expect(see(upload, { userId: 'member', projectId: 'x', memberOf: ['shared'] })).toMatch(/not shared/);
    });

    it('shows built-ins to everyone, and never a rejected upload', () => {
      expect(see(builtIn, { userId: 'anyone' })).toBeNull();
      expect(see({ ...upload, validationStatus: REJECTED }, { userId: 'owner' })).toMatch(/rejected/);
    });
  });

  it('never deploys a rejected agent, not even for its uploader', () => {
    no({ ...upload, validationStatus: REJECTED }, { ...reviewOff, deployerId: 'owner', projectId: 'mine' }, /rejected in review/);
    no({ ...upload, validationStatus: REJECTED }, reviewOff, /rejected in review/);
  });

  it('needs a build before an upload deploys', () => {
    no({ ...upload, imageUrl: null }, { ...reviewOff, deployerId: 'owner', projectId: 'mine' }, /no built image yet/);
  });

  it('rejects an unknown slug with a 400', () => {
    expect(() => assertDeployableAgentType('nope', null, reviewOff)).toThrow(BadRequestException);
    no(null, reviewOff, /Unknown agent type/);
  });

  describe('SDK support window', () => {
    const approved = { ...upload, validationStatus: APPROVED };
    const ctx = { ...reviewOff, deployerId: 'member', projectId: 'shared' };

    it('refuses an upload built before its SDK version was recorded, or with no SDK', () => {
      no({ ...approved, sdkVersion: null }, ctx, /no stella-ai-agent-sdk version is known for its build\. Rebuild it/);
    });

    it('refuses an upload built with an SDK below the supported floor, on restart too', () => {
      no({ ...approved, sdkVersion: '0.0.1' }, ctx, new RegExp(`built with stella-ai-agent-sdk 0\\.0\\.1, older than .*\\(${MIN_SUPPORTED_SDK_VERSION.replace(/\./g, '\\.')}\\)`));
      no({ ...approved, sdkVersion: '0.0.1' }, reviewOff, /older than the oldest this STELLA supports/);
    });

    it('accepts the floor itself, and does not ask built-ins (built from this repo)', () => {
      ok({ ...approved, sdkVersion: MIN_SUPPORTED_SDK_VERSION }, ctx);
      ok({ ...builtIn, sdkVersion: null }, ctx);
    });
  });
});

describe('isPodAlive', () => {
  it('counts a pending or running pod with no terminated container', () => {
    expect(isPodAlive({ phase: 'Running', containerStatuses: [{ state: {} }] })).toBe(true)
    expect(isPodAlive({ phase: 'Pending' })).toBe(true)
  })

  it('does not count a missing, finished or OOMKilled pod', () => {
    expect(isPodAlive(null)).toBe(false)
    expect(isPodAlive({ phase: 'Succeeded' })).toBe(false)
    expect(isPodAlive({ phase: 'Failed' })).toBe(false)
    expect(isPodAlive({ phase: 'Running', containerStatuses: [{ state: { terminated: { reason: 'OOMKilled' } } }] })).toBe(false)
  })
})
