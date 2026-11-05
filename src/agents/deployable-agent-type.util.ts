import { BadRequestException } from '@nestjs/common';
import { AgentValidationStatus } from '@prisma/client';

/** The AgentType fields that decide whether a type may be deployed. */
export interface DeployableAgentTypeFields {
  isBuiltIn: boolean;
  validationStatus: AgentValidationStatus;
  imageUrl: string | null;
}

/**
 * Whether an agent type may be deployed into a session. This replaces a
 * hard-coded allow-list of the two built-in slugs, which made every uploaded
 * agent undeployable however it had been reviewed.
 *
 * The rule:
 * - The type must exist.
 * - An admin must have approved it. Uploaded code runs in the cluster, so the
 *   review in the admin panel is the gate. Built-ins are seeded as APPROVED.
 * - An uploaded type must also have a built image: the build step writes
 *   `imageUrl`. Built-ins are built on demand from the repo instead.
 *
 * A failed check throws a 400 that says which step is missing, so whoever
 * deploys knows what to do next.
 */
export function assertDeployableAgentType(
  slug: string,
  record: DeployableAgentTypeFields | null,
): void {
  if (!record) {
    throw new BadRequestException(`Unknown agent type: ${slug}`);
  }
  if (record.validationStatus !== AgentValidationStatus.APPROVED) {
    const why =
      record.validationStatus === AgentValidationStatus.REJECTED
        ? 'was rejected in review'
        : 'is waiting for an admin to approve it';
    throw new BadRequestException(`Agent type ${slug} ${why}, so it cannot be deployed yet`);
  }
  if (!record.isBuiltIn && !record.imageUrl) {
    throw new BadRequestException(
      `Agent type ${slug} has no built image yet. Build it from My Agents, then deploy again`,
    );
  }
}
