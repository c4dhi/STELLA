import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  IsUUID,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { CONNECTOR_HANDLE_REGEX } from '../connector-bindings.util.js';

/** An emoji can be several code points (ZWJ sequences, flags), so not 1 char. */
export const CONNECTOR_ICON_MAX = 32;
export const CONNECTOR_DESCRIPTION_MAX = 500;

export const CONNECTOR_AUTH_TYPES = ['bearer', 'none'] as const;
export type ConnectorAuthTypeInput = (typeof CONNECTOR_AUTH_TYPES)[number];

export class CreateConnectorDto {
  /** Shown in Settings and the deploy wizard, e.g. "ELIAS interview questions". */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  /** An emoji for the card, e.g. "🗂️". */
  @IsOptional()
  @IsString()
  @MaxLength(CONNECTOR_ICON_MAX)
  icon?: string;

  /** What it is for, in the owner's words. */
  @IsOptional()
  @IsString()
  @MaxLength(CONNECTOR_DESCRIPTION_MAX)
  description?: string;

  /** How agents address it: lowercase letters, digits, hyphens. Unique per user. */
  @IsString()
  @Matches(CONNECTOR_HANDLE_REGEX, {
    message:
      'handle must start with a letter and use only lowercase letters, digits and hyphens (max 40)',
  })
  handle: string;

  /** The server's MCP endpoint (Streamable HTTP). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  url: string;

  /** Defaults to bearer. */
  @IsOptional()
  @IsIn(CONNECTOR_AUTH_TYPES)
  authType?: ConnectorAuthTypeInput;

  /** The bearer token. Stored encrypted and never returned. */
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  token?: string;
}

export class UpdateConnectorDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  /** An emoji for the card. An empty string clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(CONNECTOR_ICON_MAX)
  icon?: string;

  /** An empty string clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(CONNECTOR_DESCRIPTION_MAX)
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(CONNECTOR_HANDLE_REGEX, {
    message:
      'handle must start with a letter and use only lowercase letters, digits and hyphens (max 40)',
  })
  handle?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsIn(CONNECTOR_AUTH_TYPES)
  authType?: ConnectorAuthTypeInput;

  /** A new token replaces the stored one. Leave out to keep it. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(8192)
  token?: string;
}

export class SetConnectorSharesDto {
  /** Projects whose members may bind this connector. Replaces the current set; [] unshares all. */
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  projectIds: string[];
}

export class CallConnectorToolDto {
  /** The tool's arguments, as its inputSchema describes them. */
  @IsOptional()
  @IsObject()
  arguments?: Record<string, unknown>;
}
