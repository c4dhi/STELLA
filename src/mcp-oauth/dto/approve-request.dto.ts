import { IsIn } from 'class-validator';

export class ApproveRequestDto {
  @IsIn(['read', 'read_write'])
  access: 'read' | 'read_write';
}
