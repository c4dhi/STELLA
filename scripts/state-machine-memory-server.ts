// The real gRPC controller and the real StateMachineService, with the database
// replaced by a Map, so agent code can drive the state machine without Postgres
// or the backend. For local simulation only (see
// agents/stella-v2-agent/tests/goal_persona_sim.py); nothing deploys this.
//
//   SM_PORT=50999 node --import ./scripts/register-ts-node-esm.mjs scripts/state-machine-memory-server.ts
import 'reflect-metadata';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { StateMachineService } from '../src/state-machine/state-machine.service.js';
import { StateMachineGrpcController } from '../src/state-machine/state-machine-grpc.controller.js';

const store = new Map<string, any>();
const prisma: any = {
  sessionState: {
    findUnique: async ({ where: { sessionId } }: any) =>
      store.has(sessionId) ? structuredClone(store.get(sessionId)) : null,
    create: async ({ data }: any) => {
      const record = {
        id: `s-${data.sessionId}`, completedTasks: [], skippedTasks: [], deliverables: {},
        turnsWithoutProgress: 0, totalTurns: 0, lastTransitionAt: null, ...data,
      };
      store.set(data.sessionId, record);
      return structuredClone(record);
    },
    update: async ({ where: { sessionId }, data }: any) => {
      const next = structuredClone(store.get(sessionId));
      for (const [k, v] of Object.entries<any>(data)) {
        next[k] = v && typeof v === 'object' && !Array.isArray(v) && 'increment' in v
          ? Number(next[k] || 0) + v.increment : v;
      }
      store.set(sessionId, next);
      return structuredClone(next);
    },
    upsert: async ({ where: { sessionId }, create, update }: any) =>
      store.has(sessionId)
        ? prisma.sessionState.update({ where: { sessionId }, data: update })
        : prisma.sessionState.create({ data: create }),
    delete: async ({ where: { sessionId } }: any) => store.delete(sessionId),
    deleteMany: async ({ where: { sessionId } }: any) => store.delete(sessionId),
  },
  session: { update: async () => ({}), findUnique: async () => null },
};

const quiet = { log() {}, warn() {}, error(m: string) { console.error(m); }, debug() {}, verbose() {} };
const service = new StateMachineService(prisma);
(service as any).logger = quiet;
const controller: any = new StateMachineGrpcController(service);
controller.logger = quiet;

const definition = protoLoader.loadSync(join(process.cwd(), 'proto', 'state_machine.proto'));
const pkg: any = grpc.loadPackageDefinition(definition);
const svcDef = pkg.stella.statemachine.v1.StateMachineService.service;

const handlers: Record<string, grpc.UntypedHandleCall> = {};
for (const rpc of Object.keys(svcDef)) {
  const method = rpc[0].toLowerCase() + rpc.slice(1);
  handlers[rpc] = (call: any, callback: any) => {
    Promise.resolve(controller[method](call.request))
      .then((res: unknown) => callback(null, res))
      .catch((err: Error) => callback({ code: grpc.status.INTERNAL, details: err.message }));
  };
}

const server = new grpc.Server();
server.addService(svcDef, handlers);
const port = process.env.SM_PORT || '50999';
server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
  if (err) throw err;
  console.log(`in-memory state machine listening on ${port}`);
});
