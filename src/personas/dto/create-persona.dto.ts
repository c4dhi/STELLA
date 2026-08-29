import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsObject,
  MinLength,
  MaxLength,
  Validate,
} from 'class-validator';
import { IsPersonaVariableMap } from './persona-variables.validator';

export class CreatePersonaDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @IsString()
  @IsOptional()
  @MaxLength(16)
  icon?: string;

  /**
   * The identity prompt. Injected verbatim by the agent — any {{placeholder}}
   * written here is passed through untouched rather than resolved, which is what
   * keeps a persona independent of any agent type's variable palette.
   */
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(20000)
  systemPrompt: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  greeting?: string;

  /** TTS voice identity (a voice id, not a language). Empty = provider default. */
  @IsString()
  @IsOptional()
  @MaxLength(128)
  voice?: string;

  /**
   * Fallback language for deployments with no plan. A plan that declares a
   * language always wins — see frontend-ui/src/lib/sessionLanguage.ts.
   */
  @IsString()
  @IsOptional()
  @MaxLength(16)
  language?: string;

  /**
   * Author-defined values referenced elsewhere as {{persona.<key>}}.
   * Flat map of identifier-safe keys to short string values.
   */
  @IsObject()
  @IsOptional()
  @Validate(IsPersonaVariableMap)
  variables?: Record<string, string>;
}
