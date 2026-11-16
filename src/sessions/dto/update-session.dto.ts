import { IsString, IsOptional, MaxLength, IsBoolean, ValidateIf } from 'class-validator';

export class UpdateSessionDto {
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  /**
   * When everyone has left (#162): true closes the session, false keeps it
   * open, null follows the project.
   */
  @IsOptional()
  @ValidateIf((o) => o.closeWhenEmpty !== null)
  @IsBoolean()
  closeWhenEmpty?: boolean | null;
}
