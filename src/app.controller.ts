import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './common/decorators/public.decorator';
import { LiveKitService } from './livekit/livekit.service';
import { AgentImageService } from './agent-image/agent-image.service';
import * as os from 'os';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly livekit: LiveKitService,
    private readonly agentImage: AgentImageService,
  ) {}

  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Public()
  @Get('health')
  health() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'session-management-server',
    };
  }

  @Public()
  @Get('version')
  version() {
    return {
      // Set from the deployment manifest by deploy.sh: <semver>-<run>-g<sha>.
      // 'dev' means the service is running outside a scripted deploy.
      version: process.env.STELLA_VERSION || 'dev',
      service: 'session-management-server',
    };
  }

  @Public()
  @Get('health/ready')
  async ready() {
    const containerd = await this.agentImage.checkContainerdHealth();
    if (!containerd.ok) {
      throw new HttpException(
        { status: 'unready', containerd },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { status: 'ready', containerd };
  }

  @Public()
  @Get('network-info')
  getNetworkInfo() {
    // Auto-detect local IP, filtering out container/docker networks
    const networkInterfaces = os.networkInterfaces();
    let localIp = 'localhost';

    for (const interfaceName of Object.keys(networkInterfaces)) {
      const interfaces = networkInterfaces[interfaceName];
      if (interfaces) {
        for (const iface of interfaces) {
          if (iface.family === 'IPv4' && !iface.internal) {
            const ip = iface.address;
            // Skip container/docker IPs:
            // - 10.x.x.x (Kubernetes pod network, Docker default bridge)
            // - 172.16.x.x to 172.31.x.x (Docker bridge networks)
            // - 169.254.x.x (link-local)
            if (
              !ip.startsWith('10.') &&
              !ip.startsWith('172.') &&
              !ip.startsWith('169.254.')
            ) {
              localIp = ip;
              break;
            }
          }
        }
      }
      if (localIp !== 'localhost') break;
    }

    // Determine if running in Kubernetes by checking for K8s env vars
    const isKubernetes = !!process.env.KUBERNETES_SERVICE_HOST;

    // Build URLs based on environment
    let serverUrl: string;
    let livekitUrl: string;
    let frontendUrl: string;
    let source: string;

    if (process.env.PUBLIC_SERVER_URL) {
      // Priority 1: Use explicitly configured URLs
      serverUrl = process.env.PUBLIC_SERVER_URL;
      livekitUrl = this.livekit.getPublicServerUrl();
      frontendUrl = process.env.PUBLIC_FRONTEND_URL || `http://${localIp}:5173`;
      source = 'configured';
    } else if (isKubernetes) {
      // Priority 2: Running in K8s - use port-forward ports with detected IP
      // Port forwarding exposes on standard service ports
      const port = process.env.PORT || 3000;
      serverUrl = `http://${localIp}:${port}`;
      livekitUrl = `ws://${localIp}:7880`;
      frontendUrl = `http://${localIp}:5173`;  // Frontend forwarded to 5173
      source = 'kubernetes-auto-detected';
    } else {
      // Priority 3: Local development - use standard ports with detected IP
      const port = process.env.PORT || 3000;
      serverUrl = `http://${localIp}:${port}`;
      livekitUrl = `ws://${localIp}:7880`;
      frontendUrl = `http://${localIp}:5173`;
      source = 'local-auto-detected';
    }

    return {
      serverUrl,
      livekitUrl,
      frontendUrl,
      hostname: os.hostname(),
      platform: os.platform(),
      source,
      environment: isKubernetes ? 'kubernetes' : 'local',
      detectedIp: localIp,
    };
  }
}
