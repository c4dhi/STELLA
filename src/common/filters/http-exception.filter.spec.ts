import { ArgumentsHost, BadRequestException, HttpStatus } from '@nestjs/common';
import { MulterError } from 'multer';
import { AllExceptionsFilter, statusForMulterError } from './http-exception.filter';

function hostFor(response: { status: jest.Mock; json: jest.Mock }): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'POST', url: '/upload', body: {}, params: {}, query: {} }),
    }),
  } as unknown as ArgumentsHost;
}

function run(exception: unknown) {
  const json = jest.fn();
  const response = { status: jest.fn().mockReturnValue({ json }), json };
  new AllExceptionsFilter().catch(exception, hostFor(response as any));
  return { status: response.status.mock.calls[0][0], body: json.mock.calls[0][0] };
}

describe('multer errors map by code, not message text', () => {
  it('a wrong upload field name is a 400, whatever multer words it', () => {
    // multer 2.4.0 wording; older versions said "Unexpected field".
    const error = new MulterError('LIMIT_UNEXPECTED_FILE', 'wrongfield');
    error.message = 'Unexpected file field';
    const { status, body } = run(error);

    expect(status).toBe(HttpStatus.BAD_REQUEST);
    expect(body.message).toBe('Unexpected file field');
  });

  it('the old wording is a 400 as well', () => {
    const error = new MulterError('LIMIT_UNEXPECTED_FILE', 'wrongfield');
    error.message = 'Unexpected field';
    expect(run(error).status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('a file over the size limit is a 413', () => {
    expect(run(new MulterError('LIMIT_FILE_SIZE', 'file')).status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
  });

  it('the other limits are client errors too', () => {
    for (const code of ['LIMIT_FILE_COUNT', 'LIMIT_PART_COUNT', 'LIMIT_FIELD_KEY', 'LIMIT_FIELD_VALUE', 'LIMIT_FIELD_COUNT'] as const) {
      expect(statusForMulterError(new MulterError(code))).toBe(HttpStatus.BAD_REQUEST);
    }
  });

  it('does not change how other errors are handled', () => {
    expect(run(new Error('boom')).status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(run(new BadRequestException('nope')).status).toBe(HttpStatus.BAD_REQUEST);
  });
});
