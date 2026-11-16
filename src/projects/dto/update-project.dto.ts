import { IsBoolean, IsString, IsNotEmpty, MinLength, MaxLength, IsOptional, ValidateIf, IsInt, Min, Max } from 'class-validator';

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @ValidateIf((o) => o.agentInactivityTimeoutMinutes !== null)
  @IsInt()
  @Min(1)
  @Max(1440) // Max 24 hours
  agentInactivityTimeoutMinutes?: number | null;

  /** When everyone has left a session: true closes it, false keeps it open (#162). */
  @IsOptional()
  @IsBoolean()
  closeSessionWhenEmpty?: boolean;
}
