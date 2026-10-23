import { jest } from '@jest/globals';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  Module,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ResourceAccessService } from '../auth/resource-access.service.js';

/**
 * Over HTTP with the real controller: every route that names a session, a
 * participant or a project answers only to members of that project. The
 * signed-in caller is picked by the `x-test-user` header, standing in for the
 * JWT guard.
 */

const SESSION = '2b1c7a0e-4f3d-4a8e-9c6b-1d2e3f4a5b6c';
const PROJECT = 'proj-a';
const PARTICIPANT = 'part-a';

const USERS: Record<string, unknown> = {
  member: { userId: 'u-member', projectIds: [PROJECT] },
  outsider: { userId: 'u-outsider', projectIds: ['proj-b'] },
  // The phone app reads its own session's messages with a participant token.
  ownParticipant: {
    type: 'participant',
    participantId: PARTICIPANT,
    sessionId: SESSION,
  },
  otherParticipant: {
    type: 'participant',
    participantId: 'part-b',
    sessionId: 'sess-b',
  },
};

@Injectable()
class TestUserGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    req.user = USERS[req.headers['x-test-user']];
    return true;
  }
}

const ok = () => jest.fn(async () => ({ ok: true }));

const sessionsService = {
  create: ok(),
  findAll: ok(),
  findOne: ok(),
  createJoinToken: ok(),
  getTimeline: ok(),
  update: ok(),
  close: ok(),
  delete: ok(),
  registerParticipant: ok(),
  listParticipants: ok(),
  getParticipantConnectionInfoWithToken: ok(),
  removeParticipant: ok(),
  getMessages: ok(),
  getMessagesSince: ok(),
  getTranscriptMessageTypes: ok(),
  exportTranscript: jest.fn(async () => ({
    meta: { sessionName: 'S', mode: 'transcript' },
  })),
  getListenerStatus: ok(),
  getBatchListenerStatus: jest.fn(async (ids: string[]) => ids),
  getSessionEventStream: jest.fn(() => of({ data: '{}' })),
  getProjectEventStream: jest.fn(() => of({ data: '{}' })),
};

const prisma = {
  session: {
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
      where.id === SESSION ? { id: SESSION, projectId: PROJECT } : null,
    ),
    findMany: jest.fn(
      async ({
        where,
      }: {
        where: { id: { in: string[] }; projectId: { in: string[] } };
      }) =>
        where.id.in.includes(SESSION) && where.projectId.in.includes(PROJECT)
          ? [{ id: SESSION }]
          : [],
    ),
  },
  participant: {
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
      where.id === PARTICIPANT
        ? { id: PARTICIPANT, session: { projectId: PROJECT } }
        : null,
    ),
  },
};

@Module({
  controllers: [SessionsController],
  providers: [
    { provide: SessionsService, useValue: sessionsService },
    { provide: PrismaService, useValue: prisma },
    ResourceAccessService,
    { provide: APP_GUARD, useClass: TestUserGuard },
  ],
})
class TestSessionsModule {}

type Route = [method: string, path: string, body?: unknown];

const SESSION_ROUTES: Route[] = [
  ['GET', `/sessions/${SESSION}`],
  ['POST', `/sessions/${SESSION}/joinToken`, { identity: 'x' }],
  ['GET', `/sessions/${SESSION}/timeline`],
  ['PATCH', `/sessions/${SESSION}`, {}],
  ['PATCH', `/sessions/${SESSION}/close`],
  ['DELETE', `/sessions/${SESSION}`],
  ['POST', `/sessions/${SESSION}/participants`, { name: 'x' }],
  ['GET', `/sessions/${SESSION}/participants`],
  ['GET', `/sessions/${SESSION}/messages`],
  ['GET', `/sessions/${SESSION}/messages/latest?since=2026-01-01T00:00:00Z`],
  ['GET', `/sessions/${SESSION}/transcript/types`],
  ['GET', `/sessions/${SESSION}/transcript`],
  ['GET', `/sessions/${SESSION}/listener-status`],
  ['GET', `/sessions/${SESSION}/events`],
  ['GET', `/participants/${PARTICIPANT}/connection-info`],
  ['DELETE', `/participants/${PARTICIPANT}`],
];

const PROJECT_ROUTES: Route[] = [
  ['GET', `/projects/${PROJECT}/sessions`],
  ['POST', `/projects/${PROJECT}/sessions`, {}],
  ['GET', `/projects/${PROJECT}/sessions/events`],
];

describe('session routes check project membership (HTTP)', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestSessionsModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  const call = (user: string, [method, path, body]: Route) =>
    fetch(`${url}${path}`, {
      method,
      headers: { 'x-test-user': user, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const serviceCalls = () =>
    Object.values(sessionsService).reduce(
      (n, fn) => n + fn.mock.calls.length,
      0,
    );

  describe.each([...SESSION_ROUTES, ...PROJECT_ROUTES])(
    '%s %s',
    (method, path, body) => {
      const route: Route = [method, path, body];

      it('answers a member', async () => {
        const res = await call('member', route);
        expect(res.status).toBeLessThan(300);
        expect(serviceCalls()).toBe(1);
      });

      it('refuses a signed-in user from another project, without touching the session', async () => {
        const res = await call('outsider', route);
        expect([403, 404]).toContain(res.status);
        expect(serviceCalls()).toBe(0);
      });

      it("refuses another session's participant token", async () => {
        const res = await call('otherParticipant', route);
        expect([403, 404]).toContain(res.status);
        expect(serviceCalls()).toBe(0);
      });
    },
  );

  it('lets a participant read its own session messages (phone app)', async () => {
    const res = await call('ownParticipant', [
      'GET',
      `/sessions/${SESSION}/messages`,
    ]);
    expect(res.status).toBe(200);
    expect(sessionsService.getMessages).toHaveBeenCalledTimes(1);
  });

  it("does not let a participant token use the dashboard's session routes", async () => {
    const res = await call('ownParticipant', [
      'GET',
      `/sessions/${SESSION}/transcript`,
    ]);
    expect(res.status).toBe(404);
    expect(sessionsService.exportTranscript).not.toHaveBeenCalled();
  });

  it('answers 404 for a session that does not exist, as for one the caller cannot see', async () => {
    const res = await call('member', ['GET', '/sessions/nope/messages']);
    expect(res.status).toBe(404);
  });

  it('batch listener status only reports sessions the caller can see', async () => {
    const res = await call('outsider', [
      'POST',
      '/sessions/listener-status/batch',
      { sessionIds: [SESSION] },
    ]);
    expect(res.status).toBe(201);
    expect(sessionsService.getBatchListenerStatus).toHaveBeenCalledWith([]);

    await call('member', [
      'POST',
      '/sessions/listener-status/batch',
      { sessionIds: [SESSION] },
    ]);
    expect(sessionsService.getBatchListenerStatus).toHaveBeenLastCalledWith([
      SESSION,
    ]);
  });
});
