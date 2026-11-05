import { BadRequestException } from '@nestjs/common';
import { AgentValidationStatus } from '@prisma/client';
import { CURRENT_SDK_VERSION, MIN_SUPPORTED_SDK_VERSION } from '../agent-package/manifest-defaults.js';
import { assertDeployableAgentType } from './deployable-agent-type.util.js';

const { APPROVED, PENDING, REJECTED } = AgentValidationStatus;

describe('assertDeployableAgentType', () => {
  const builtIn = { isBuiltIn: true, validationStatus: APPROVED, imageUrl: null, userId: null, sdkVersion: null };
  const upload = { isBuiltIn: false, validationStatus: PENDING, imageUrl: 'elias-interviewer:0.1.0', userId: 'owner', sdkVersion: CURRENT_SDK_VERSION };
  const reviewOff = { reviewRequired: false };
  const reviewOn = { reviewRequired: true };

  const ok = (record: any, ctx: any) => expect(() => assertDeployableAgentType('x', record, ctx)).not.toThrow();
  const no = (record: any, ctx: any, msg: RegExp) =>
    expect(() => assertDeployableAgentType('x', record, ctx)).toThrow(msg);

  it('deploys an approved built-in for anyone, with or without review', () => {
    ok(builtIn, { ...reviewOff, deployerId: 'anyone' });
    ok(builtIn, { ...reviewOn, deployerId: 'anyone' });
  });

  describe('review off (the default)', () => {
    it('lets the uploader deploy their unreviewed upload', () => {
      ok(upload, { ...reviewOff, deployerId: 'owner' });
    });

    it('does not let another user deploy someone else’s unreviewed upload', () => {
      no(upload, { ...reviewOff, deployerId: 'someone-else' }, /only the user who uploaded it/);
    });

    it('turns it away on a path with no user', () => {
      no(upload, { ...reviewOff, deployerId: null }, /only the user who uploaded it/);
    });

    it('lets a restart or wake of an existing instance through', () => {
      ok(upload, reviewOff);
    });

    it('lets anyone deploy an upload an admin approved', () => {
      ok({ ...upload, validationStatus: APPROVED }, { ...reviewOff, deployerId: 'someone-else' });
    });
  });

  describe('review on', () => {
    it('makes even the uploader wait for an admin', () => {
      no(upload, { ...reviewOn, deployerId: 'owner' }, /waiting for an admin/);
    });

    it('stops a restart or wake of an unreviewed upload', () => {
      no(upload, reviewOn, /waiting for an admin/);
    });

    it('lets an approved upload deploy for anyone', () => {
      ok({ ...upload, validationStatus: APPROVED }, { ...reviewOn, deployerId: 'someone-else' });
    });
  });

  it('never deploys a rejected agent, not even for its uploader', () => {
    no({ ...upload, validationStatus: REJECTED }, { ...reviewOff, deployerId: 'owner' }, /rejected in review/);
    no({ ...upload, validationStatus: REJECTED }, reviewOff, /rejected in review/);
  });

  it('needs a build before an upload deploys', () => {
    no({ ...upload, imageUrl: null }, { ...reviewOff, deployerId: 'owner' }, /no built image yet/);
  });

  it('rejects an unknown slug with a 400', () => {
    expect(() => assertDeployableAgentType('nope', null, reviewOff)).toThrow(BadRequestException);
    no(null, reviewOff, /Unknown agent type/);
  });

  describe('SDK support window', () => {
    const approved = { ...upload, validationStatus: APPROVED };
    const ctx = { ...reviewOff, deployerId: 'anyone' };

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
