import { jest } from '@jest/globals';
import { BadRequestException, ForbiddenException, ValidationPipe } from '@nestjs/common';
import { UpdatePublicConfigDto } from './dto/update-public-config.dto.js';
import { ProjectsService } from './projects.service.js';

// The options main.ts gives the global pipe.
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const validate = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: UpdatePublicConfigDto }) as Promise<UpdatePublicConfigDto>;

const PERSONA = '7d3c3a52-2b3e-4b8e-9d61-6f1d1c1f8a01';
const CONFIGURATION = '0f6b2c1e-6a4d-4f0e-8c3b-2a9e5d7c4b10';
const CONNECTOR = '1c3d221a-3b5f-4c2a-9e8d-7f6a5b4c3d2e';

describe('public project setup', () => {
  it('accepts the persona, configuration and connectors the setup wizard sends', async () => {
    const dto = await validate({
      isPublic: true,
      agentConfig: {
        name: 'ELIAS',
        personaId: PERSONA,
        agentConfigurationId: CONFIGURATION,
        connectorBindings: [{ connectorId: CONNECTOR, slot: 'elias' }],
      },
    });
    expect(dto.agentConfig).toMatchObject({
      personaId: PERSONA,
      agentConfigurationId: CONFIGURATION,
      connectorBindings: [{ connectorId: CONNECTOR, slot: 'elias' }],
    });
  });

  it('still refuses unknown fields and malformed bindings', async () => {
    await expect(validate({ isPublic: true, agentConfig: { name: 'x', surprise: 1 } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate({ isPublic: true, agentConfig: { name: 'x', connectorBindings: [{ connectorId: 'not-a-uuid' }] } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate({ isPublic: true, agentConfig: { name: 'x', connectorBindings: [{ connectorId: CONNECTOR, slot: 'Bad Slot' }] } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('checks the connectors as the owner when the setup is saved', async () => {
    const prisma: any = {
      project: {
        findUnique: jest.fn(async () => ({ id: 'proj', publicAgentTypeId: 'type-1' })),
        update: jest.fn(async ({ data }: any) => ({ id: 'proj', ...data })),
      },
      agentType: { findUnique: jest.fn(async () => ({ id: 'type-1' })) },
      projectMembership: { findFirst: jest.fn(async () => ({ userId: 'owner-1' })) },
    };
    const agents: any = {
      checkDeployable: jest.fn(async () => {
        throw new BadRequestException('This agent needs a connector for: ELIAS');
      }),
    };
    const service = new ProjectsService(prisma, agents);
    await expect(
      service.updatePublicConfig('proj', { isPublic: true, agentConfig: { name: 'ELIAS' } } as UpdatePublicConfigDto, 'owner-1'),
    ).rejects.toThrow('needs a connector for: ELIAS');
    expect(agents.checkDeployable).toHaveBeenCalledWith('type-1', 'owner-1', 'proj', undefined);
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  describe('only the owner binds connectors to the public agent', () => {
    // A stored project row; `connector.findMany` must never be needed.
    const setup = (row: { publicAgentTypeId: string | null; publicAgentConfig?: unknown }) => {
      let stored: any = { id: 'proj', publicAgentConfig: null, ...row };
      const prisma: any = {
        project: {
          findUnique: jest.fn(async () => stored),
          update: jest.fn(async ({ data }: any) => {
            stored = {
              ...stored,
              ...(data.publicAgentTypeId !== undefined && { publicAgentTypeId: data.publicAgentTypeId }),
              ...(data.publicAgentConfig !== undefined && { publicAgentConfig: data.publicAgentConfig }),
            };
            return stored;
          }),
        },
        agentType: { findUnique: jest.fn(async ({ where }: any) => ({ id: where.id })) },
        projectMembership: { findFirst: jest.fn(async () => ({ userId: 'owner-1' })) },
      };
      const agents: any = { checkDeployable: jest.fn(async () => undefined) };
      return { prisma, agents, service: new ProjectsService(prisma, agents), stored: () => stored };
    };
    const bind = (connectorId: string) => ({ connectorBindings: [{ connectorId, slot: 'elias' }] });
    const save = (service: ProjectsService, callerId: string, dto: object) =>
      service.updatePublicConfig('proj', { isPublic: true, ...dto } as UpdatePublicConfigDto, callerId);

    it('refuses a member binding any connector, the owner\'s or a shared one', async () => {
      const { prisma, agents, service } = setup({ publicAgentTypeId: 'type-1' });
      for (const id of ['owner-private', 'owner-shared', 'member-private']) {
        await expect(save(service, 'member-1', { agentConfig: { name: 'ELIAS', ...bind(id) } })).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      }
      expect(agents.checkDeployable).not.toHaveBeenCalled();
      expect(prisma.project.update).not.toHaveBeenCalled();
    });

    it('refuses the two-call bypass: bindings with no agent type, then the type alone', async () => {
      const { prisma, service } = setup({ publicAgentTypeId: null });
      // 1. No agent type yet: the bindings are still refused.
      await expect(
        save(service, 'member-1', { agentConfig: { name: 'ELIAS', ...bind('owner-private') } }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.project.update).not.toHaveBeenCalled();
    });

    it('refuses a member moving the owner\'s bindings to another agent type', async () => {
      const { prisma, agents, service } = setup({
        publicAgentTypeId: 'type-1',
        publicAgentConfig: { name: 'ELIAS', ...bind('owner-private') },
      });
      await expect(save(service, 'member-1', { agentTypeId: 'type-2' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(agents.checkDeployable).not.toHaveBeenCalled();
      expect(prisma.project.update).not.toHaveBeenCalled();
    });

    it('re-checks the stored bindings against the new type when the owner changes only the type', async () => {
      const { agents, service } = setup({ publicAgentTypeId: null, publicAgentConfig: { name: 'ELIAS', ...bind('owner-private') } });
      await save(service, 'owner-1', { agentTypeId: 'type-2' });
      expect(agents.checkDeployable).toHaveBeenCalledWith('type-2', 'owner-1', 'proj', [
        { connectorId: 'owner-private', slot: 'elias' },
      ]);
    });

    it('lets the owner bind connectors, and checks them as the owner', async () => {
      const { prisma, agents, service } = setup({ publicAgentTypeId: 'type-1' });
      await save(service, 'owner-1', { agentConfig: { name: 'ELIAS', ...bind('owner-private') } });
      expect(agents.checkDeployable).toHaveBeenCalledWith('type-1', 'owner-1', 'proj', [
        { connectorId: 'owner-private', slot: 'elias' },
      ]);
      expect(prisma.project.update).toHaveBeenCalled();
    });

    it('lets a member save a setup without bindings, which clears the owner\'s bindings', async () => {
      const { service, stored } = setup({
        publicAgentTypeId: 'type-1',
        publicAgentConfig: { name: 'ELIAS', ...bind('owner-private') },
      });
      await save(service, 'member-1', { agentConfig: { name: 'Other setup' } });
      expect(stored().publicAgentConfig).toEqual({ name: 'Other setup' });
    });

    it('lets a member change other fields without touching the bindings', async () => {
      const { agents, service, stored } = setup({
        publicAgentTypeId: 'type-1',
        publicAgentConfig: { name: 'ELIAS', ...bind('owner-private') },
      });
      await save(service, 'member-1', { agentTypeId: 'type-1', enabled: true });
      expect(agents.checkDeployable).not.toHaveBeenCalled();
      expect(stored().publicAgentConfig).toEqual({ name: 'ELIAS', ...bind('owner-private') });
    });
  });
});
