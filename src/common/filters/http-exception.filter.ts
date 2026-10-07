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

    // Always log errors with full details
    this.logger.error(
      `${request.method} ${request.url} - ${status} - ${errorMessage}`,
    );

    // Log additional context for server errors (5xx)
    if (status >= 500) {
      this.logger.error(`Request body: ${JSON.stringify(request.body || {})}`);
      this.logger.error(`Request params: ${JSON.stringify(request.params || {})}`);
      this.logger.error(`Request query: ${JSON.stringify(request.query || {})}`);
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
      path: request.url,
      message: clientMessage,
    });
  }
}
