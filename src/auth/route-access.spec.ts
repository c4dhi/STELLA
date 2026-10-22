import { jest } from '@jest/globals';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  Type,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import { AgentsController } from '../agents/agents.controller.js';
import { AgentsService } from '../agents/agents.service.js';
import { AgentImageService } from '../agent-image/agent-image.service.js';
import { InvitationsController } from '../invitations/invitations.controller.js';
import { InvitationsService } from '../invitations/invitations.service.js';
import { MetricsController } from '../metrics/metrics.controller.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ResourceAccessService } from './resource-access.service.js';

/**
 * Over HTTP with the real controllers: agent, invitation and metrics routes
 * answer only to members of the project they belong to. The signed-in caller
 * is picked by the `x-test-user` header, standing in for the JWT guard.
 */

const PROJECT = 'proj-a';
const SESSION = '2b1c7a0e-4f3d-4a8e-9c6b-1d2e3f4a5b6c';
const AGENT = 'agent-a';
const INVITATION = 'inv-a';

const USERS: Record<string, unknown> = {
  member: { userId: 'u-member', projectIds: [PROJECT] },
  outsider: { userId: 'u-outsider', projectIds: ['proj-b'] },
  participant: {
    type: 'participant',
    participantId: 'part-a',
    sessionId: SESSION,
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

const inProject = (id: string, own: string) =>
  id === own ? { session: { projectId: PROJECT } } : null;

const prisma = {
  session: {
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
      where.id === SESSION ? { projectId: PROJECT } : null,
    ),
  },
  agentInstance: {
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
      inProject(where.id, AGENT),
    ),
  },
  invitation: {
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
      inProject(where.id, INVITATION),
    ),
  },
};

type Route = [method: string, path: string, body?: unknown];

const CASES: {
  name: string;
  controller: Type<unknown>;
  services: Record<string, Record<string, jest.Mock>>;
  providers: (s: Record<string, Record<string, jest.Mock>>) => unknown[];
  routes: Route[];
}[] = [
  {
    name: 'AgentsController',
    controller: AgentsController,
    services: {
      agents: {
        create: ok(),
        findOne: ok(),
        getLogs: ok(),
        streamLogs: jest.fn(async () => () => undefined),
        remove: ok(),
        delete: ok(),
        restart: ok(),
      },
    },
    providers: (s) => [
      { provide: AgentsService, useValue: s.agents },
      { provide: AgentImageService, useValue: {} },
    ],
    routes: [
      ['POST', `/sessions/${SESSION}/agents`, { name: 'x' }],
      ['GET', `/agents/${AGENT}`],
      ['GET', `/agents/${AGENT}/logs`],
      ['GET', `/agents/${AGENT}/logs/stream`],
      ['DELETE', `/agents/${AGENT}`],
      ['DELETE', `/agents/${AGENT}/permanent`],
      ['POST', `/agents/${AGENT}/restart`],
    ],
  },
  {
    name: 'InvitationsController',
    controller: InvitationsController,
    services: {
      invitations: {
        create: ok(),
        findBySession: ok(),
        findOne: ok(),
        revoke: ok(),
        delete: ok(),
      },
    },
    providers: (s) => [
      { provide: InvitationsService, useValue: s.invitations },
    ],
    routes: [
      ['POST', `/sessions/${SESSION}/invitations`, {}],
      ['GET', `/sessions/${SESSION}/invitations`],
      ['GET', `/invitations/${INVITATION}`],
      ['DELETE', `/invitations/${INVITATION}/revoke`],
      ['DELETE', `/invitations/${INVITATION}`],
    ],
  },
  {
    name: 'MetricsController',
    controller: MetricsController,
    services: {
      metrics: {
        getProjectMetrics: ok(),
        getProjectMetricsStream: jest.fn(() => of({ data: '{}' })),
      },
    },
    providers: (s) => [{ provide: MetricsService, useValue: s.metrics }],
    routes: [
      ['GET', `/metrics/projects/${PROJECT}`],
      ['GET', `/metrics/projects/${PROJECT}/stream`],
    ],
  },
];

describe.each(CASES)(
  '$name checks project membership (HTTP)',
  ({ controller, services, providers, routes }) => {
    let app: INestApplication;
    let url: string;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [controller],
        providers: [
          ...(providers(services) as never[]),
          { provide: PrismaService, useValue: prisma },
          ResourceAccessService,
          { provide: APP_GUARD, useClass: TestUserGuard },
        ],
      }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      await app.listen(0);
      url = await app.getUrl();
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(() => jest.clearAllMocks());

    const call = async (user: string, [method, path, body]: Route) => {
      const ac = new AbortController();
      const res = await fetch(`${url}${path}`, {
        method,
        signal: ac.signal,
        headers: { 'x-test-user': user, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      // The log stream stays open; the status line is all we need.
      ac.abort();
      return res;
    };

    const serviceCalls = () =>
      Object.values(services)
        .flatMap((s) => Object.values(s))
        .reduce((n, fn) => n + fn.mock.calls.length, 0);

    describe.each(routes)('%s %s', (method, path, body) => {
      const route: Route = [method, path, body];

      it('answers a member', async () => {
        const res = await call('member', route);
        expect(res.status).toBeLessThan(300);
        expect(serviceCalls()).toBe(1);
      });

      it('refuses a signed-in user from another project, without touching the service', async () => {
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
  },
);
