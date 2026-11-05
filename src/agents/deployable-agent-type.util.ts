import { BadRequestException } from '@nestjs/common';
import { AgentValidationStatus } from '@prisma/client';

/** The AgentType fields that decide whether a type may be deployed. */
export interface DeployableAgentTypeFields {
  isBuiltIn: boolean;
  validationStatus: AgentValidationStatus;
  imageUrl: string | null;
  userId: string | null;
}

export interface DeployContext {
  /** The platform setting "uploaded agents need an admin's approval" (off by default). */
  reviewRequired: boolean;
  /**
   * Who is deploying. Pass it on a new deploy. Leave it out for a restart or
   * a wake, which re-creates an instance that was already allowed to deploy.
   */
  deployerId?: string | null;
}

/**
 * Whether an agent type may be deployed into a session. This replaces a
 * hard-coded allow-list of the two built-in slugs, which made every uploaded
 * agent undeployable.
 *
 * - The type must exist.
 * - A type an admin REJECTED never deploys.
 * - An APPROVED type deploys for anyone. Built-ins are seeded APPROVED.
 * - A type nobody has reviewed yet (PENDING, i.e. every fresh upload):
 *   - with review off (the default), deploys for the user who uploaded it;
 *   - with review on, waits for an admin.
 *   Only the uploader, because nobody else has vouched for that code yet.
 *   Once an admin approves it, anyone can deploy it.
 * - An uploaded type must also have a built image: the build writes
 *   `imageUrl`. Built-ins are built on demand from the repo instead.
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
  if (record.validationStatus === AgentValidationStatus.REJECTED) {
    throw new BadRequestException(`Agent type ${slug} was rejected in review, so it cannot be deployed`);
  }
  if (record.validationStatus !== AgentValidationStatus.APPROVED) {
    if (ctx.reviewRequired) {
      throw new BadRequestException(
        `Agent type ${slug} is waiting for an admin to approve it, so it cannot be deployed yet`,
      );
    }
    const isNewDeploy = ctx.deployerId !== undefined;
    if (isNewDeploy && (!record.userId || record.userId !== ctx.deployerId)) {
      throw new BadRequestException(
        `Agent type ${slug} has not been reviewed, so only the user who uploaded it can deploy it`,
      );
    }
  }
  if (!record.isBuiltIn && !record.imageUrl) {
    throw new BadRequestException(
      `Agent type ${slug} has no built image yet. Build it from My Agents, then deploy again`,
    );
  }
}
