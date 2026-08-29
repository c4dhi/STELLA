import {
  IsString,
  IsOptional,
  IsObject,
  MinLength,
  MaxLength,
  Validate,
} from 'class-validator';
import { IsPersonaVariableMap } from './persona-variables.validator';

export class UpdatePersonaDto {
  @IsString()
  @IsOptional()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @IsString()
  @IsOptional()
  @MaxLength(16)
  icon?: string;

  @IsString()
  @IsOptional()
  @MinLength(1)
  @MaxLength(20000)
  systemPrompt?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  greeting?: string;

  @IsString()
  @IsOptional()
  @MaxLength(128)
  voice?: string;

  @IsString()
  @IsOptional()
  @MaxLength(16)
  language?: string;

  @IsObject()
  @IsOptional()
  @Validate(IsPersonaVariableMap)
  variables?: Record<string, string>;
}
