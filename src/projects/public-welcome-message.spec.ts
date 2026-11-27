import { jest } from '@jest/globals';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdatePublicConfigDto } from './dto/update-public-config.dto.js';
import { ProjectsService } from './projects.service.js';
import { publicInvitationOptions } from '../public-projects/public-invitation-options.js';

// #213: the optional message every public-link participant sees before the session.
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const validate = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: UpdatePublicConfigDto }) as Promise<UpdatePublicConfigDto>;

function serviceWith() {
  const prisma: any = {
    project: {
      findUnique: jest.fn(async () => ({ id: 'proj', publicAgentTypeId: null })),
      update: jest.fn(async ({ data }: any) => ({ id: 'proj', ...data })),
    },
    projectMembership: { findFirst: jest.fn(async () => ({ userId: 'owner-1' })) },
  };
  const agents: any = { checkDeployable: jest.fn(async () => undefined) };
  return { service: new ProjectsService(prisma, agents), prisma };
}

describe('public welcome message', () => {
  it('accepts a message up to 500 characters, and null to clear it', async () => {
    expect((await validate({ isPublic: true, welcomeMessage: 'x'.repeat(500) })).welcomeMessage).toHaveLength(500);
    expect((await validate({ isPublic: true, welcomeMessage: null })).welcomeMessage).toBeNull();
  });

  it('refuses a message over 500 characters, the same limit as an invitation', async () => {
    await expect(validate({ isPublic: true, welcomeMessage: 'x'.repeat(501) })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores a trimmed message, an empty one as none, and leaves it alone when not sent', async () => {
    const { service, prisma } = serviceWith();
    await service.updatePublicConfig('proj', { isPublic: true, welcomeMessage: '  Hello  ' } as UpdatePublicConfigDto, 'owner-1');
    expect(prisma.project.update.mock.calls[0][0].data.publicWelcomeMessage).toBe('Hello');

    await service.updatePublicConfig('proj', { isPublic: true, welcomeMessage: '   ' } as UpdatePublicConfigDto, 'owner-1');
    expect(prisma.project.update.mock.calls[1][0].data.publicWelcomeMessage).toBeNull();

    await service.updatePublicConfig('proj', { isPublic: true, enabled: false } as UpdatePublicConfigDto, 'owner-1');
    expect(prisma.project.update.mock.calls[2][0].data).not.toHaveProperty('publicWelcomeMessage');
  });

  it('puts the message on every public participant invitation, and nothing when there is none', () => {
    const base = { publicVisualizerType: 'text', publicVisualizerLocked: true };
    expect(publicInvitationOptions({ ...base, publicWelcomeMessage: 'Hello' })).toEqual({
      visualizerType: 'text',
      visualizerLocked: true,
      customMessage: 'Hello',
    });
    expect(publicInvitationOptions({ ...base, publicWelcomeMessage: null }).customMessage).toBeUndefined();
    expect(publicInvitationOptions({ publicVisualizerType: null, publicVisualizerLocked: false, publicWelcomeMessage: null }))
      .toEqual({ visualizerType: undefined, visualizerLocked: false, customMessage: undefined });
  });
});
