import { jest } from '@jest/globals';
import { ArgumentsHost, BadRequestException, HttpStatus, Logger } from '@nestjs/common';
import { MulterError } from 'multer';
import { AllExceptionsFilter, redactSecrets, redactUrl, statusForMulterError } from './http-exception.filter.js';

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

describe('secrets in the URL', () => {
  it('masks token-like query values and keeps the rest', () => {
    expect(redactUrl('/mcp?token=stella_pat_abc')).toBe('/mcp?token=REDACTED');
    expect(redactUrl('/sse/events?token=eyJ.x.y&projectId=p1')).toBe('/sse/events?token=REDACTED&projectId=p1');
    expect(redactUrl('/x?access_token=a&api_key=b&page=2')).toBe('/x?access_token=REDACTED&api_key=REDACTED&page=2');
    expect(redactUrl('/sessions/s1')).toBe('/sessions/s1');
  });

  it('leaves the other query values exactly as sent', () => {
    expect(redactUrl('/x?q=a%20b&token=t&name=a+b')).toBe('/x?q=a%20b&token=REDACTED&name=a+b');
    expect(redactUrl('/x?%74oken=t')).toBe('/x?%74oken=REDACTED');
  });

  it('masks path segments that come from secret route params', () => {
    expect(redactUrl('/invitations/join/inv-tok/accept', { token: 'inv-tok' })).toBe(
      '/invitations/join/REDACTED/accept',
    );
    expect(redactUrl('/p/pub%20tok/join?x=1', { publicToken: 'pub tok' })).toBe('/p/REDACTED/join?x=1');
    expect(redactUrl('/sessions/s1', { id: 's1' })).toBe('/sessions/s1');
  });

  it('masks secrets in bodies at any depth, and every value of an env var map', () => {
    expect(
      redactSecrets({
        email: 'a@b.c',
        password: 'hunter2',
        variables: { OPENAI_API_KEY: 'sk-1', REGION: 'eu' },
        agent: { envVars: { DEEPGRAM: 'dg-1' }, name: 'Grace' },
        items: [{ accessToken: 't' }],
      }),
    ).toEqual({
      email: 'a@b.c',
      password: 'REDACTED',
      variables: { OPENAI_API_KEY: 'REDACTED', REGION: 'REDACTED' },
      agent: { envVars: { DEEPGRAM: 'REDACTED' }, name: 'Grace' },
      items: [{ accessToken: 'REDACTED' }],
    });
  });

  it('keeps a token sent in the URL out of the log and the error body', () => {
    const logged: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
      logged.push(String(m));
    });
    const json = jest.fn();
    const response = { status: jest.fn().mockReturnValue({ json }), json };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({
          method: 'POST',
          url: '/mcp?token=stella_pat_secret',
          body: {},
          params: {},
          query: { token: 'stella_pat_secret' },
        }),
      }),
    } as unknown as ArgumentsHost;

    const filter = new AllExceptionsFilter();
    filter.catch(new BadRequestException('Send the access token in the Authorization header'), host);
    filter.catch(new Error('boom'), host); // 5xx also logs the query
    spy.mockRestore();

    expect(logged.join('\n')).not.toContain('stella_pat_secret');
    expect(JSON.stringify(json.mock.calls)).not.toContain('stella_pat_secret');
    expect(json.mock.calls[0][0]).toMatchObject({ path: '/mcp?token=REDACTED' });
  });

  it('keeps passwords, API keys and join tokens out of a 5xx log and its error body', () => {
    const logged: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
      logged.push(String(m));
    });
    const json = jest.fn();
    const response = { status: jest.fn().mockReturnValue({ json }), json };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({
          method: 'POST',
          url: '/invitations/join/join-secret/accept',
          body: { password: 'hunter2', variables: { OPENAI_API_KEY: 'sk-live' } },
          params: { token: 'join-secret' },
          query: {},
        }),
      }),
    } as unknown as ArgumentsHost;

    new AllExceptionsFilter().catch(new Error('boom'), host);
    spy.mockRestore();

    const everything = logged.join('\n') + JSON.stringify(json.mock.calls);
    for (const secret of ['hunter2', 'sk-live', 'join-secret']) {
      expect(everything).not.toContain(secret);
    }
    expect(json.mock.calls[0][0]).toMatchObject({ path: '/invitations/join/REDACTED/accept' });
  });
});
