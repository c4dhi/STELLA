import { builtSdkProblem } from '../agent-package/sdk-support.js';
import { BadRequestException } from '@nestjs/common';
import { AgentValidationStatus } from '@prisma/client';

/** The AgentType fields that decide whether a type may be deployed. */
export interface DeployableAgentTypeFields {
  isBuiltIn: boolean;
  validationStatus: AgentValidationStatus;
  imageUrl: string | null;
  userId: string | null;
  /** The SDK the stored build has installed (null: not built). */
  sdkVersion: string | null;
  /** The projects its owner shared this upload with (AgentTypeProjectShare). */
  projectShares?: { projectId: string }[];
}

export interface DeployContext {
  /** The platform setting "uploaded agents need an admin's approval" (on by default: an unset setting counts as on). */
  reviewRequired: boolean;
  /**
   * Who is deploying. Pass it on a new deploy. Leave it out for a restart or
   * a wake, which re-creates an instance that was already allowed to deploy.
   */
  deployerId?: string | null;
  /** The project the agent is deployed into. Needed with `deployerId`. */
  projectId?: string | null;
}

/**
 * Whether `userId` may see and deploy this agent type in `projectId`, or why
 * not. The one rule for both the agent lists and a new deploy:
 *
 * - Built-in agents: anyone. They are seeded APPROVED.
 * - An uploaded agent is its owner's. Others see and deploy it only in a
 *   project the owner shared it with, and never change it.
 * - An admin's review: REJECTED never deploys; with review on, an upload waits
 *   for APPROVED, for its owner too (on is the default). With review off, the
 *   owner sharing it is what lets others use it.
 *
 * `projectId` null asks about any project: is it shared with one of `memberOf`?
 */
export function agentTypeAccessProblem(
  record: DeployableAgentTypeFields,
  who: { userId: string | null | undefined; projectId?: string | null; memberOf?: string[]; reviewRequired: boolean },
): string | null {
  if (record.validationStatus === AgentValidationStatus.REJECTED) {
    return 'was rejected in review, so it cannot be deployed';
  }
  if (record.isBuiltIn) {
    return record.validationStatus === AgentValidationStatus.APPROVED ? null : 'is not available';
  }
  if (who.reviewRequired && record.validationStatus !== AgentValidationStatus.APPROVED) {
    return 'is waiting for an admin to approve it, so it cannot be deployed yet';
  }
  if (who.userId && record.userId === who.userId) return null;
  const shared = new Set((record.projectShares ?? []).map((s) => s.projectId));
  const allowed = who.projectId ? shared.has(who.projectId) : (who.memberOf ?? []).some((id) => shared.has(id));
  return allowed ? null : 'is not shared with this project. Only its owner can share it, from the Agent Library';
}

/**
 * Whether an agent type may be deployed into a session.
 *
 * - The type must exist.
 * - A new deploy (`deployerId` set) follows `agentTypeAccessProblem`: built-ins
 *   for anyone, an upload for its owner and in the projects it is shared with.
 * - A restart or wake re-creates an instance that was allowed: only a review
 *   decision since (REJECTED, or review turned on before approval) stops it.
 * - An uploaded type must also have a built image: the build writes
 *   `imageUrl`. Built-ins are built on demand from the repo instead.
 * - An uploaded type's build must have an SDK inside the support window
 *   (sdk-support.ts). Raising the floor makes older builds undeployable
 *   until they are rebuilt.
 *
 * A failed check throws a 400 that says which step is missing.
 */
export function assertDeployableAgentType(
  slug: string,
  record: DeployableAgentTypeFields | null,
  ctx: DeployContext,
): void {
  if (!record) {
    throw new BadRequestException(`Unknown agent type: ${slug}`);
  }
  const isNewDeploy = ctx.deployerId !== undefined;
  const problem = isNewDeploy
    ? agentTypeAccessProblem(record, { userId: ctx.deployerId, projectId: ctx.projectId ?? null, reviewRequired: ctx.reviewRequired })
    : agentTypeAccessProblem(record, { userId: record.userId, reviewRequired: ctx.reviewRequired });
  if (problem) {
    throw new BadRequestException(`Agent type ${slug} ${problem}`);
  }
  if (!record.isBuiltIn && !record.imageUrl) {
    throw new BadRequestException(
      `Agent type ${slug} has no built image yet. Build it from My Agents, then deploy again`,
    );
  }
  // Built-ins are built from this repo's SDK on demand. An upload keeps the SDK
  // its last build installed, which can fall out of the support window.
  const sdkProblem = record.isBuiltIn ? null : builtSdkProblem(record.sdkVersion);
  if (sdkProblem) {
    throw new BadRequestException(
      `Agent type ${slug} cannot be deployed: ${sdkProblem}. Rebuild it with a supported SDK from My Agents`,
    );
  }
}
