import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * The MCP spec asks servers to check Origin against DNS rebinding. Desktop
 * and CLI clients send no Origin and pass; a browser page may only call /mcp
 * from the STELLA frontend itself (CORS_ORIGIN / PUBLIC_FRONTEND_URL), or from
 * localhost in development.
 */
@Injectable()
export class McpOriginGuard implements CanActivate {
  private readonly allowed: string[];
  private readonly allowLocalhost: boolean;

  constructor(config: ConfigService) {
    this.allowed = (
      config.get<string>('CORS_ORIGIN') ||
      config.get<string>('PUBLIC_FRONTEND_URL') ||
      ''
    )
      .split(',')
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean);
    this.allowLocalhost =
      (config.get<string>('NODE_ENV') || 'development') === 'development';
  }

  canActivate(context: ExecutionContext): boolean {
    const origin = context.switchToHttp().getRequest().headers.origin as
      string | undefined;
    if (!origin) return true;
    if (
      this.allowed.includes(origin) ||
      (this.allowLocalhost && LOCALHOST.test(origin))
    )
      return true;
    throw new ForbiddenException('Origin not allowed for MCP');
  }
}
