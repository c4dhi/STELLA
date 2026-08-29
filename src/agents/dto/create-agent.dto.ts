import { IsString, IsNotEmpty, IsOptional, MaxLength, IsBoolean, IsObject, IsUUID } from 'class-validator';

export class CreateAgentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsString()
  @IsOptional()
  @MaxLength(10)  // Emoji is typically 1-4 characters
  icon?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  agentType?: string;  // Agent type identifier (e.g., "stella-light-agent") for gRPC orchestrator

  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;  // Agent-specific config (e.g., { plan: {...}, plan_id: "..." })

  // Stored pipeline configuration to apply. When set, the backend loads the
  // configuration by ID, verifies it matches this agent's type and is not
  // outdated, and uses its (merged) overrides as pipeline_config — ignoring any
  // client-supplied config.pipeline_config. This is what makes type/version
  // scoping enforceable server-side.
  @IsUUID()
  @IsOptional()
  agentConfigurationId?: string;

  // Persona (agent identity) to deploy with. Resolved server-side and snapshotted
  // into config.persona, so a later edit reaches the next deployment rather than
  // this one — the same rule pipeline_config follows. Omitted = the system default
  // persona. See docs/rfcs/2026-08-29_persona-separation.md.
  @IsUUID()
  @IsOptional()
  personaId?: string;

  @IsUUID()
  @IsOptional()
  envVarTemplateId?: string;  // Environment variable template to use for agent pod

  @IsObject()
  @IsOptional()
  envVars?: Record<string, string>;  // Additional env vars to merge with template (overrides template values)

  @IsBoolean()
  @IsOptional()
  forceRebuild?: boolean;  // Force rebuild the agent image (useful after SDK updates)
}
