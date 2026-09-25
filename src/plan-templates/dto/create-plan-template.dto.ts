import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsObject,
  Validate,
  MinLength,
  MaxLength,
} from 'class-validator';
import { Prisma } from '@prisma/client';
import { IsPlanContent } from './plan-content.validator';

export class CreatePlanTemplateDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @IsObject()
  @Validate(IsPlanContent)
  @IsNotEmpty()
  content: Prisma.InputJsonValue;
}
