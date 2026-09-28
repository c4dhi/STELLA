import { Controller, Post, Body } from '@nestjs/common';
import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { LiveKitService } from './livekit.service.js';
import { Public } from '../common/decorators/public.decorator.js';

export class CreateTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  roomName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  identity: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;
}

@Controller('livekit')
export class LiveKitController {
  constructor(private readonly livekitService: LiveKitService) {}

  /**
   * Public endpoint to generate LiveKit access tokens
   * This keeps the API secret secure on the backend
   *
   * POST /livekit/token
   * Body: { roomName: string, identity: string, name?: string }
   * Returns: { token: string }
   */
  @Public()
  @Post('token')
  async createToken(@Body() dto: CreateTokenDto): Promise<{ token: string }> {
    const token = await this.livekitService.createToken(
      dto.roomName,
      dto.identity,
      dto.name,
    );

    return { token };
  }
}
