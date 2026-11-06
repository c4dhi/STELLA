import {
  IsBoolean,
  IsString,
  IsOptional,
  IsDateString,
  IsUUID,
  ValidateNested,
  IsObject,
  IsInt,
  Min,
  Max,
  MaxLength,
  IsArray,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ConnectorBindingDto } from '../../agents/dto/create-agent.dto.js';

/**
 * Agent configuration for public projects
 */
export class PublicAgentConfigDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  icon?: string;

  @IsOptional()
  @IsObject()
  plan?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  pipelineConfig?: Record<string, unknown>;

  /** A saved Agent Configuration, resolved by id at spawn. */
  @IsOptional()
  @IsUUID()
  agentConfigurationId?: string;

  /** The persona picked in the setup; absent = the system default. */
  @IsOptional()
  @IsUUID()
  personaId?: string;

  @IsOptional()
  @IsUUID()
  envVarTemplateId?: string;

  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;

  /**
   * Connectors every public session's agent may call, as on a normal deploy.
   * Public agents are deployed as the project owner, so each must be the
   * owner's own or shared with the project. Checked when saved and on deploy.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ConnectorBindingDto)
  connectorBindings?: ConnectorBindingDto[];
}

/**
 * DTO for configuring public project settings
 */
export class UpdatePublicConfigDto {
  @IsBoolean()
  isPublic: boolean;

  @IsOptional()
  @IsUUID()
  agentTypeId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PublicAgentConfigDto)
  agentConfig?: PublicAgentConfigDto;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  visualizerType?: string;

  @IsOptional()
  @IsBoolean()
  visualizerLocked?: boolean;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  // Max session duration in seconds; null/undefined = no limit (default). Max 7200 (2h).
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(7200)
  maxSessionDurationSeconds?: number | null;
}
