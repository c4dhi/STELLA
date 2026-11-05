import { BadRequestException } from '@nestjs/common';
import { AgentValidationStatus } from '@prisma/client';
import { assertDeployableAgentType } from './deployable-agent-type.util.js';

describe('assertDeployableAgentType', () => {
  const builtIn = {
    isBuiltIn: true,
    validationStatus: AgentValidationStatus.APPROVED,
    imageUrl: null,
  };
  const uploaded = {
    isBuiltIn: false,
    validationStatus: AgentValidationStatus.APPROVED,
    imageUrl: 'elias-interviewer:1.0.0',
  };

  it('lets an approved built-in deploy without a stored image', () => {
    expect(() => assertDeployableAgentType('stella-v2-agent', builtIn)).not.toThrow();
  });

  it('lets an approved, built uploaded agent deploy (no allow-list)', () => {
    expect(() => assertDeployableAgentType('elias-interviewer', uploaded)).not.toThrow();
  });

  it('rejects an unknown slug', () => {
    expect(() => assertDeployableAgentType('nope', null)).toThrow(/Unknown agent type: nope/);
  });

  it('rejects an uploaded agent still waiting for review', () => {
    expect(() =>
      assertDeployableAgentType('elias-interviewer', {
        ...uploaded,
        validationStatus: AgentValidationStatus.PENDING,
      }),
    ).toThrow(/waiting for an admin to approve/);
  });

  it('rejects an agent that was rejected in review', () => {
    expect(() =>
      assertDeployableAgentType('elias-interviewer', {
        ...uploaded,
        validationStatus: AgentValidationStatus.REJECTED,
      }),
    ).toThrow(/rejected in review/);
  });

  it('rejects an approved uploaded agent that was never built', () => {
    expect(() =>
      assertDeployableAgentType('elias-interviewer', { ...uploaded, imageUrl: null }),
    ).toThrow(/no built image yet/);
  });

  it('throws 400s, not 500s', () => {
    expect(() => assertDeployableAgentType('nope', null)).toThrow(BadRequestException);
  });
});
