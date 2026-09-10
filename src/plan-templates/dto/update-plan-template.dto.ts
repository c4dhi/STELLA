import {
  IsString,
  IsOptional,
  IsObject,
  Validate,
  MinLength,
  MaxLength,
} from 'class-validator';
import { Prisma } from '@prisma/client';
import { IsPlanContent } from './plan-content.validator';

export class UpdatePlanTemplateDto {
  @IsString()
  @IsOptional()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @IsObject()
  @Validate(IsPlanContent)
  @IsOptional()
  content?: Prisma.InputJsonValue;
}
