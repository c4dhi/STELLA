import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator'

/** The projects a custom agent is shared with, replacing the current set. */
export class UpdateAgentSharesDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  projectIds!: string[]
}
