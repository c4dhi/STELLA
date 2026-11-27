import { jest } from '@jest/globals';
// ProjectsService imports AgentsService, whose transitive deps
// (@kubernetes/client-node, uuid) are ESM-only and trip ts-jest. remove() only
// needs a stub AgentsService, so cut that module subtree at the boundary
// (same approach as sessions.service.spec.ts).
jest.mock('../agents/agents.service', () => ({ AgentsService: class {} }));

import { NotFoundException } from '@nestjs/common';
import { ProjectsService } from './projects.service.js';

type SessionRow = { id: string; room?: { livekitRoomName: string } | null };

/**
 * remove() must close every session's LiveKit room itself (#1047) — Prisma's
 * cascade delete only removes the DB rows, never the live LiveKit room, so a
 * participant still on the call would otherwise be left in a room nobody ever
 * tears down.
 */
function setup(opts: {
  project: { id: string; name: string; sessions: SessionRow[] } | null;
}) {
  const prisma: any = {
    project: {
      findUnique: jest.fn(async () => opts.project),
      delete: jest.fn(async () => undefined),
    },
  };
  const agents: any = { stopAllSessionAgents: jest.fn(async () => undefined) };
  const livekit: any = { deleteRoom: jest.fn(async () => undefined) };
  const service = new ProjectsService(prisma, agents, livekit);
  return { service, prisma, agents, livekit };
}

describe('ProjectsService.remove', () => {
  afterEach(() => jest.clearAllMocks());

  it('throws NotFound when the project does not exist', async () => {
    const { service } = setup({ project: null });
    await expect(service.remove('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('closes the LiveKit room of every session with one, then deletes the project', async () => {
    const { service, prisma, livekit } = setup({
      project: {
        id: 'p1',
        name: 'Proj',
        sessions: [
          { id: 's1', room: { livekitRoomName: 's1-room' } },
          { id: 's2', room: { livekitRoomName: 's2-room' } },
        ],
      },
    });

    await service.remove('p1');

    expect(livekit.deleteRoom).toHaveBeenCalledWith('s1-room');
    expect(livekit.deleteRoom).toHaveBeenCalledWith('s2-room');
    expect(prisma.project.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
  });

  it('skips sessions with no room, without failing the delete', async () => {
    const { service, livekit, prisma } = setup({
      project: { id: 'p1', name: 'Proj', sessions: [{ id: 's1', room: null }] },
    });

    await service.remove('p1');

    expect(livekit.deleteRoom).not.toHaveBeenCalled();
    expect(prisma.project.delete).toHaveBeenCalled();
  });

  it('still closes the room and deletes the project when stopping agents fails', async () => {
    const { service, agents, livekit, prisma } = setup({
      project: {
        id: 'p1',
        name: 'Proj',
        sessions: [{ id: 's1', room: { livekitRoomName: 's1-room' } }],
      },
    });
    agents.stopAllSessionAgents.mockRejectedValueOnce(new Error('pod gone'));

    await service.remove('p1');

    expect(livekit.deleteRoom).toHaveBeenCalledWith('s1-room');
    expect(prisma.project.delete).toHaveBeenCalled();
  });

  it('still deletes the project when closing the room fails', async () => {
    const { service, livekit, prisma } = setup({
      project: {
        id: 'p1',
        name: 'Proj',
        sessions: [{ id: 's1', room: { livekitRoomName: 's1-room' } }],
      },
    });
    livekit.deleteRoom.mockRejectedValueOnce(new Error('livekit unreachable'));

    await expect(service.remove('p1')).resolves.toEqual({
      message: 'Project deleted successfully',
    });
    expect(prisma.project.delete).toHaveBeenCalled();
  });
});
