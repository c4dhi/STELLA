import { ConfigService } from '@nestjs/config';
import * as childProcess from 'child_process';

import { AgentImageService } from './agent-image.service';
import { AgentTypeService } from '../agent-type/agent-type.service';

jest.mock('child_process');

describe('AgentImageService.checkContainerdHealth', () => {
  const agentTypeService = {} as AgentTypeService;
  const originalK8sEnv = process.env.KUBERNETES_SERVICE_HOST;

  function makeService(env: Record<string, string | undefined>): AgentImageService {
    const config = new ConfigService();
    jest.spyOn(config, 'get').mockImplementation((key: string, defaultValue?: unknown) => {
      return env[key] ?? defaultValue;
    });
    return new AgentImageService(config, agentTypeService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    // execSync is called by the constructor's checkDockerSocket(); make it succeed by default.
    (childProcess.execSync as jest.Mock).mockReturnValue(Buffer.from(''));
  });

  afterEach(() => {
    if (originalK8sEnv === undefined) {
      delete process.env.KUBERNETES_SERVICE_HOST;
    } else {
      process.env.KUBERNETES_SERVICE_HOST = originalK8sEnv;
    }
  });

  it('returns ok when CONTAINER_RUNTIME is not k3s (local dev)', async () => {
    delete process.env.KUBERNETES_SERVICE_HOST;
    const svc = makeService({ NODE_ENV: 'local' });

    await expect(svc.checkContainerdHealth()).resolves.toEqual({ ok: true });
    expect(childProcess.exec).not.toHaveBeenCalled();
  });

  it('returns ok when CONTAINER_RUNTIME=none even if NODE_ENV=production', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    const svc = makeService({ NODE_ENV: 'production', CONTAINER_RUNTIME: 'none' });

    await expect(svc.checkContainerdHealth()).resolves.toEqual({ ok: true });
    expect(childProcess.exec).not.toHaveBeenCalled();
  });

  it('returns ok when k3s ctr version succeeds', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    (childProcess.exec as unknown as jest.Mock).mockImplementation(
      (_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(null, 'Client version', '');
      },
    );
    const svc = makeService({ NODE_ENV: 'production', CONTAINER_RUNTIME: 'k3s' });

    await expect(svc.checkContainerdHealth()).resolves.toEqual({ ok: true });
    expect(childProcess.exec).toHaveBeenCalledWith(
      'k3s ctr version',
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
  });

  it('returns ok=false with error when k3s ctr version fails', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    (childProcess.exec as unknown as jest.Mock).mockImplementation(
      (_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(new Error('connect: connection refused'), '', '');
      },
    );
    const svc = makeService({ NODE_ENV: 'production', CONTAINER_RUNTIME: 'k3s' });

    await expect(svc.checkContainerdHealth()).resolves.toEqual({
      ok: false,
      error: 'connect: connection refused',
    });
  });
});

describe('AgentImageService.pruneOldConfigImages', () => {
  const agentTypeService = {} as AgentTypeService;
  const originalK8sEnv = process.env.KUBERNETES_SERVICE_HOST;

  const config = {
    imageName: 'stella-v2-agent',
    dockerfilePath: 'agents/stella-v2-agent/Dockerfile',
    contextPath: '.',
    tag: 'latest',
  };

  // Newest first, matching `docker images` ordering.
  const ALL_TAGS = [
    'stella-v2-agent:cfg-111111111111',
    'stella-v2-agent:cfg-222222222222',
    'stella-v2-agent:cfg-333333333333',
    'stella-v2-agent:cfg-444444444444',
    'stella-v2-agent:cfg-555555555555',
    'stella-v2-agent:cfg-666666666666',
  ];

  let issued: string[];

  function makeService(env: Record<string, string | undefined> = {}): AgentImageService {
    const configService = new ConfigService();
    jest.spyOn(configService, 'get').mockImplementation((key: string, defaultValue?: unknown) => {
      return env[key] ?? defaultValue;
    });
    return new AgentImageService(configService, agentTypeService);
  }

  /** Route each shell command to a canned result, recording every command issued. */
  function routeExec(router: (cmd: string) => { stdout?: string; error?: Error }): void {
    (childProcess.exec as unknown as jest.Mock).mockImplementation(
      (cmd: string, optsOrCb: unknown, maybeCb?: unknown) => {
        issued.push(cmd);
        const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (
          err: Error | null,
          stdout: string,
          stderr: string,
        ) => void;
        const result = router(cmd);
        if (result.error) {
          cb(result.error, '', '');
        } else {
          // jest.mock('child_process') strips exec's util.promisify.custom symbol, so
          // promisify() resolves the FIRST callback value rather than { stdout, stderr }.
          // Hand it the object shape the service destructures.
          cb(null, { stdout: result.stdout ?? '', stderr: '' } as never, '');
        }
      },
    );
  }

  function removedImages(): string[] {
    return issued
      .filter((cmd) => cmd.startsWith('docker rmi '))
      .map((cmd) => cmd.slice('docker rmi '.length).trim());
  }

  beforeEach(() => {
    jest.clearAllMocks();
    issued = [];
    delete process.env.KUBERNETES_SERVICE_HOST;
    (childProcess.execSync as jest.Mock).mockReturnValue(Buffer.from(''));
  });

  afterEach(() => {
    if (originalK8sEnv === undefined) {
      delete process.env.KUBERNETES_SERVICE_HOST;
    } else {
      process.env.KUBERNETES_SERVICE_HOST = originalK8sEnv;
    }
  });

  it('keeps the newest N tags and removes the rest', async () => {
    routeExec((cmd) => {
      if (cmd.startsWith('docker images --filter=reference=')) return { stdout: ALL_TAGS.join('\n') + '\n' };
      if (cmd.startsWith('kubectl get pods')) return { stdout: 'stella-v2-agent:cfg-111111111111\npostgres:16-alpine\n' };
      return { stdout: '' };
    });

    const svc = makeService({ NODE_ENV: 'local', AGENT_IMAGE_KEEP_VERSIONS: '3' });
    await (svc as any).pruneOldConfigImages(config, 'stella-v2-agent:cfg-111111111111');

    expect(removedImages()).toEqual([
      'stella-v2-agent:cfg-444444444444',
      'stella-v2-agent:cfg-555555555555',
      'stella-v2-agent:cfg-666666666666',
    ]);
  });

  it('never removes a tag a live pod still references', async () => {
    // A pod is still pinned to the OLDEST tag - the auto-pause/wake case.
    routeExec((cmd) => {
      if (cmd.startsWith('docker images --filter=reference=')) return { stdout: ALL_TAGS.join('\n') + '\n' };
      if (cmd.startsWith('kubectl get pods')) {
        return { stdout: 'stella-v2-agent:cfg-111111111111\nstella-v2-agent:cfg-666666666666\n' };
      }
      return { stdout: '' };
    });

    const svc = makeService({ NODE_ENV: 'local', AGENT_IMAGE_KEEP_VERSIONS: '3' });
    await (svc as any).pruneOldConfigImages(config, 'stella-v2-agent:cfg-111111111111');

    expect(removedImages()).not.toContain('stella-v2-agent:cfg-666666666666');
    expect(removedImages()).toEqual([
      'stella-v2-agent:cfg-444444444444',
      'stella-v2-agent:cfg-555555555555',
    ]);
  });

  it('normalises docker.io/library/ prefixes when matching in-use images', async () => {
    routeExec((cmd) => {
      if (cmd.startsWith('docker images --filter=reference=')) return { stdout: ALL_TAGS.join('\n') + '\n' };
      if (cmd.startsWith('kubectl get pods')) {
        return { stdout: 'docker.io/library/stella-v2-agent:cfg-555555555555\n' };
      }
      return { stdout: '' };
    });

    const svc = makeService({ NODE_ENV: 'local', AGENT_IMAGE_KEEP_VERSIONS: '3' });
    await (svc as any).pruneOldConfigImages(config, 'stella-v2-agent:cfg-111111111111');

    expect(removedImages()).not.toContain('stella-v2-agent:cfg-555555555555');
  });

  it('removes nothing when the in-use set cannot be determined', async () => {
    routeExec((cmd) => {
      if (cmd.startsWith('docker images --filter=reference=')) return { stdout: ALL_TAGS.join('\n') + '\n' };
      return { error: new Error('command not found') };
    });

    const svc = makeService({ NODE_ENV: 'local', AGENT_IMAGE_KEEP_VERSIONS: '3' });
    await (svc as any).pruneOldConfigImages(config, 'stella-v2-agent:cfg-111111111111');

    expect(removedImages()).toEqual([]);
  });

  it('does nothing when the tag count is within the retention limit', async () => {
    routeExec((cmd) => {
      if (cmd.startsWith('docker images --filter=reference=')) return { stdout: ALL_TAGS.slice(0, 3).join('\n') + '\n' };
      return { stdout: '' };
    });

    const svc = makeService({ NODE_ENV: 'local', AGENT_IMAGE_KEEP_VERSIONS: '3' });
    await (svc as any).pruneOldConfigImages(config, 'stella-v2-agent:cfg-111111111111');

    expect(removedImages()).toEqual([]);
    expect(issued.some((cmd) => cmd.startsWith('kubectl'))).toBe(false);
  });

  it('never force-removes images', async () => {
    routeExec((cmd) => {
      if (cmd.startsWith('docker images --filter=reference=')) return { stdout: ALL_TAGS.join('\n') + '\n' };
      if (cmd.startsWith('kubectl get pods')) return { stdout: 'stella-v2-agent:cfg-111111111111\n' };
      return { stdout: '' };
    });

    const svc = makeService({ NODE_ENV: 'local', AGENT_IMAGE_KEEP_VERSIONS: '3' });
    await (svc as any).pruneOldConfigImages(config, 'stella-v2-agent:cfg-111111111111');

    expect(issued.some((cmd) => cmd.includes('rmi -f') || cmd.includes('--force'))).toBe(false);
  });

  it('also removes from containerd in production', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    routeExec((cmd) => {
      if (cmd.startsWith('docker images --filter=reference=')) return { stdout: ALL_TAGS.join('\n') + '\n' };
      if (cmd.includes('kubectl get pods')) return { stdout: 'stella-v2-agent:cfg-111111111111\n' };
      return { stdout: '' };
    });

    const svc = makeService({ NODE_ENV: 'production', CONTAINER_RUNTIME: 'k3s', AGENT_IMAGE_KEEP_VERSIONS: '3' });
    await (svc as any).pruneOldConfigImages(config, 'stella-v2-agent:cfg-111111111111');

    expect(issued).toContain('k3s ctr images rm docker.io/library/stella-v2-agent:cfg-444444444444');
    expect(removedImages()).toContain('stella-v2-agent:cfg-444444444444');
  });
});
