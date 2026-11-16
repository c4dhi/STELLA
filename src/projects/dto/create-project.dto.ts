import { IsBoolean, IsString, IsNotEmpty, MinLength, MaxLength, IsOptional, ValidateIf, IsInt, Min, Max } from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @IsOptional()
  @ValidateIf((o) => o.agentInactivityTimeoutMinutes !== null)
  @IsInt()
  @Min(1)
  @Max(1440)
  agentInactivityTimeoutMinutes?: number | null;

  /** When everyone has left a session: true closes it, false keeps it open (#162). */
  @IsOptional()
  @IsBoolean()
  closeSessionWhenEmpty?: boolean;
}
