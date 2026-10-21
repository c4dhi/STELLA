import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export const ACCESS_TOKEN_EXPIRY_DAYS = [7, 30, 90, 365] as const;
export const ACCESS_TOKEN_ACCESS = ['read', 'read_write'] as const;

export class CreateAccessTokenDto {
  /** What the token is for, e.g. "Claude Code on my laptop". */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  /** Days until the token stops working. Defaults to 90. */
  @IsOptional()
  @IsIn(ACCESS_TOKEN_EXPIRY_DAYS)
  expiresInDays?: (typeof ACCESS_TOKEN_EXPIRY_DAYS)[number];

  /** read: list and read only. read_write: may also create and update. Defaults to read_write. */
  @IsOptional()
  @IsIn(ACCESS_TOKEN_ACCESS)
  access?: (typeof ACCESS_TOKEN_ACCESS)[number];
}
