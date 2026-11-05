import { jest } from '@jest/globals';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
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
      service.updatePublicConfig('proj', { isPublic: true, agentConfig: { name: 'ELIAS' } } as UpdatePublicConfigDto),
    ).rejects.toThrow('needs a connector for: ELIAS');
    expect(agents.checkDeployable).toHaveBeenCalledWith('type-1', 'owner-1', 'proj', undefined);
    expect(prisma.project.update).not.toHaveBeenCalled();
  });
});
