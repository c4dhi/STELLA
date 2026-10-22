import { jest } from '@jest/globals';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  Module,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';

/**
 * Over HTTP with the real controller: every `:projectId` route answers only to
 * members of that project. The signed-in caller is picked by the `x-test-user`
 * header, standing in for the JWT guard.
 */

const PROJECT = 'proj-a';

const USERS: Record<string, unknown> = {
  member: { userId: 'u-member', projectIds: [PROJECT] },
  outsider: { userId: 'u-outsider', projectIds: ['proj-b'] },
  participant: {
    type: 'participant',
    participantId: 'part-a',
    sessionId: 'sess-a',
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

const projectsService = {
  findOne: ok(),
  getStats: ok(),
  update: ok(),
  remove: ok(),
  updatePublicConfig: ok(),
  getPublicLink: ok(),
};

@Module({
  controllers: [ProjectsController],
  providers: [
    { provide: ProjectsService, useValue: projectsService },
    { provide: ConfigService, useValue: { get: () => undefined } },
    { provide: APP_GUARD, useClass: TestUserGuard },
  ],
})
class TestProjectsModule {}

type Route = [method: string, path: string, body?: unknown];

const PROJECT_ROUTES: Route[] = [
  ['GET', `/projects/${PROJECT}`],
  ['GET', `/projects/${PROJECT}/stats`],
  ['PATCH', `/projects/${PROJECT}`, {}],
  ['DELETE', `/projects/${PROJECT}`],
  ['PATCH', `/projects/${PROJECT}/public-config`, { isPublic: false }],
  ['GET', `/projects/${PROJECT}/public-link`],
];

describe('project routes check project membership (HTTP)', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestProjectsModule],
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
    Object.values(projectsService).reduce(
      (n, fn) => n + fn.mock.calls.length,
      0,
    );

  describe.each(PROJECT_ROUTES)('%s %s', (method, path, body) => {
    const route: Route = [method, path, body];

    it('answers a member', async () => {
      const res = await call('member', route);
      expect(res.status).toBeLessThan(300);
      expect(serviceCalls()).toBe(1);
    });

    it('refuses a signed-in user from another project, without touching the project', async () => {
      const res = await call('outsider', route);
      expect([403, 404]).toContain(res.status);
      expect(serviceCalls()).toBe(0);
    });

    it('refuses a participant token', async () => {
      const res = await call('participant', route);
      expect([403, 404]).toContain(res.status);
      expect(serviceCalls()).toBe(0);
    });
  });
});
