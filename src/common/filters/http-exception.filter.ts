import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { MulterError } from 'multer';

/**
 * HTTP status for a raw multer error, decided by its `code`, never its message.
 *
 * `@nestjs/platform-express` turns multer errors into HttpExceptions by matching
 * the message text, and multer 2.4.0 reworded `LIMIT_UNEXPECTED_FILE` ("Unexpected
 * field" -> "Unexpected file field"), so a wrong upload field name fell through to
 * a 500. Matching the code keeps a client mistake a 4xx whatever multer's wording.
 */
export function statusForMulterError(error: MulterError): number {
  return error.code === 'LIMIT_FILE_SIZE'
    ? HttpStatus.PAYLOAD_TOO_LARGE
    : HttpStatus.BAD_REQUEST;
}

const SECRET_PARAM = /token|secret|password|api[_-]?key/i;
// Env var maps (template `variables`, agent `envVars`): every value is a key.
const SECRET_MAP = /^(variables|envVars|manualEnvVars)$/;

function decode(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return part;
  }
}

/**
 * The request URL with secrets masked, for logs and error bodies: query values
 * under secret-looking keys (SSE endpoints carry the JWT in `?token=`, and an
 * MCP client may put its access token there) and path segments filled from
 * secret-looking route params (`/invitations/join/:token`, `/p/:publicToken`).
 * Everything else is left exactly as sent.
 */
export function redactUrl(url: string, params: Record<string, unknown> = {}): string {
  const q = url.indexOf('?');
  let path = q === -1 ? url : url.slice(0, q);
  for (const [key, value] of Object.entries(params)) {
    if (!SECRET_PARAM.test(key) || typeof value !== 'string' || !value) continue;
    path = path
      .split('/')
      .map((segment) => (decode(segment) === value ? 'REDACTED' : segment))
      .join('/');
  }
  if (q === -1) return path;
  const query = url
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      return eq !== -1 && SECRET_PARAM.test(decode(key)) ? `${key}=REDACTED` : pair;
    })
    .join('&');
  return `${path}?${query}`;
}

/** A copy of a request body, params or query with secret values masked, at any depth. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      if (SECRET_PARAM.test(k)) return [k, 'REDACTED'];
      if (SECRET_MAP.test(k) && v !== null && typeof v === 'object' && !Array.isArray(v)) {
        return [k, Object.fromEntries(Object.keys(v).map((name) => [name, 'REDACTED']))];
      }
      return [k, redactSecrets(v)];
    }),
  );
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : exception instanceof MulterError
          ? statusForMulterError(exception)
          : HttpStatus.INTERNAL_SERVER_ERROR;

    // Extract the actual error message for logging
    let errorMessage: string;
    let errorDetails: unknown;

    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        errorMessage = exceptionResponse;
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        errorMessage = (exceptionResponse as Record<string, unknown>).message as string || exception.message;
        errorDetails = exceptionResponse;
      } else {
        errorMessage = exception.message;
      }
    } else if (exception instanceof Error) {
      errorMessage = exception.message;
    } else {
      errorMessage = 'Unknown error';
    }

    const path = redactUrl(request.url, request.params);

    // Always log errors with full details
    this.logger.error(
      `${request.method} ${path} - ${status} - ${errorMessage}`,
    );

    // Log additional context for server errors (5xx)
    if (status >= 500) {
      this.logger.error(`Request body: ${JSON.stringify(redactSecrets(request.body || {}))}`);
      this.logger.error(`Request params: ${JSON.stringify(redactSecrets(request.params || {}))}`);
      this.logger.error(`Request query: ${JSON.stringify(redactSecrets(request.query || {}))}`);
      if (exception instanceof Error) {
        this.logger.error(`Stack trace: ${exception.stack}`);
      }
      if (errorDetails) {
        this.logger.error(`Error details: ${JSON.stringify(errorDetails)}`);
      }
    }

    // Return generic message for 5xx errors, preserve message for 4xx (client errors)
    const clientMessage = status >= 500 ? 'Internal server error' : errorMessage;

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path,
      message: clientMessage,
    });
  }
}
