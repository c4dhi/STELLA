import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as k8s from '@kubernetes/client-node';
import { AgentImageService } from '../agent-image/agent-image.service';
import { buildPodEnvVars, buildSecretStringData } from './utils/agent-config-injection.util';
import {
  clampCpuLimit,
  clampMemoryLimit,
  DEFAULT_CPU_LIMIT,
  DEFAULT_MEMORY_LIMIT,
} from './utils/resource-clamping.util';

export interface AgentPodConfig {
  agentId: string;
  sessionId: string;
  projectId: string;
  agentName: string;
  agentIcon: string;
  roomName: string;
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  ttsProvider: string;
  agentConfig?: Record<string, unknown>;  // Agent-specific config (passed as AGENT_CONFIG env var)
  agentType?: string;       // Agent type (e.g., "stella-light-agent") - determines which image to use
  forceRebuild?: boolean;   // Force rebuild the agent image
  // Pre-resolved env vars: template vars decrypted and merged with manual overrides by the caller.
  // KubernetesService receives the final map and spreads it directly into the K8s Secret.
  resolvedEnvVars: Record<string, string>;
  resourceCpuLimit?: string;    // CPU limit from AgentType (e.g., "2000m") - falls back to default
  resourceMemoryLimit?: string; // Memory limit from AgentType (e.g., "2Gi") - falls back to default
}

@Injectable()
export class KubernetesService {
  private readonly logger = new Logger(KubernetesService.name);
  private readonly kc: k8s.KubeConfig;
  private readonly k8sApi: k8s.CoreV1Api;
  private readonly customObjectsApi: k8s.CustomObjectsApi;
  private readonly namespace: string;
  private readonly defaultAgentType: string;
  private readonly imagePullPolicy: string;
  private readonly grpcServerAddress: string;

  constructor(
    private configService: ConfigService,
    private agentImageService: AgentImageService,
  ) {
    this.namespace = this.configService.get<string>('KUBERNETES_NAMESPACE', 'default');
    this.defaultAgentType = this.configService.get<string>('DEFAULT_AGENT_TYPE', 'stella-v2-agent');
    this.imagePullPolicy = this.configService.get<string>('AGENT_IMAGE_PULL_POLICY', 'IfNotPresent');
    // Configurable gRPC server address for agent connections
    // Allows agents to connect from anywhere (K8s, external servers, etc.)
    this.grpcServerAddress = this.configService.get<string>('GRPC_SERVER_ADDRESS', 'session-management-server:50051');

    this.kc = new k8s.KubeConfig();

    try {
      // Try to load in-cluster config first (for production)
      this.kc.loadFromCluster();
      this.logger.log('Loaded in-cluster Kubernetes config');
    } catch (e) {
      // Fall back to local config (for development)
      this.kc.loadFromDefault();
      this.logger.log('Loaded default Kubernetes config from ~/.kube/config');
    }

    this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.customObjectsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
  }

  /**
   * Get DNS configuration for production environment.
   * Agent pods use K8s internal DNS for service discovery (stt-service, tts-service).
   *
   * Configuration via .env.production:
   *   KUBERNETES_DNS_IP=10.43.0.10  (K8s CoreDNS IP for service discovery)
   *
   * Note: CUSTOM_DNS_SERVERS (8.8.8.8) is used by STT/TTS init containers for model downloads.
   *       Agent pods use K8s DNS because they need to resolve internal services.
   */
  private getProductionDnsConfig(): object {
    if (process.env.NODE_ENV !== 'production') {
      return {}; // Use default K8s DNS in non-production
    }

    // K8s CoreDNS IP - required for agent pods to resolve internal services
    // Configure via KUBERNETES_DNS_IP in .env.production
    // Find with: kubectl get svc -n kube-system kube-dns -o jsonpath='{.spec.clusterIP}'
    const k8sDnsIp = this.configService.get<string>('KUBERNETES_DNS_IP', '');

    if (!k8sDnsIp || k8sDnsIp.trim() === '') {
      this.logger.warn('KUBERNETES_DNS_IP not set in production - using default K8s DNS');
      return {}; // Fall back to default K8s DNS
    }

    this.logger.debug(`Using K8s DNS for agent pod: ${k8sDnsIp}`);

    return {
      dnsPolicy: 'None',
      dnsConfig: {
        nameservers: [k8sDnsIp],
        searches: [
          `${this.namespace}.svc.cluster.local`,
          'svc.cluster.local',
          'cluster.local',
          // Note: UZH's cloud.science-it.uzh.ch is intentionally excluded to avoid SSL interception
        ],
        options: [
          {
            name: 'ndots',
            value: '2', // Try absolute resolution for names with 2+ dots (like api.openai.com)
          },
        ],
      },
    };
  }

  async createAgentPod(config: AgentPodConfig): Promise<{ podName: string; secretName: string }> {
    const podName = `agent-${config.agentId}`;
    const secretName = `agent-secret-${config.agentId}`;

    // Validate and clamp resource limits (security guardrails)
    const clampedCpu = clampCpuLimit(config.resourceCpuLimit);
    const clampedMemory = clampMemoryLimit(config.resourceMemoryLimit);

    // Keep logs explicit about why a caller-provided limit was not used.
    if (clampedCpu.reason === 'invalid') {
      this.logger.warn(`Invalid resource limit "${config.resourceCpuLimit}", using default "${DEFAULT_CPU_LIMIT}"`);
    } else if (clampedCpu.reason === 'exceeds_max') {
      this.logger.warn(`Resource limit "${config.resourceCpuLimit}" exceeds maximum, clamping to default "${DEFAULT_CPU_LIMIT}"`);
    }

    if (clampedMemory.reason === 'invalid') {
      this.logger.warn(`Invalid resource limit "${config.resourceMemoryLimit}", using default "${DEFAULT_MEMORY_LIMIT}"`);
    } else if (clampedMemory.reason === 'exceeds_max') {
      this.logger.warn(`Resource limit "${config.resourceMemoryLimit}" exceeds maximum, clamping to default "${DEFAULT_MEMORY_LIMIT}"`);
    }

    const cpuLimit = clampedCpu.value;
    const memoryLimit = clampedMemory.value;

    // Determine agent type (falls back to the configured default agent type)
    const agentType = config.agentType || this.defaultAgentType;

    // Ensure agent image exists (builds on-demand if needed)
    this.logger.log(`Ensuring agent image exists for type: ${agentType}`);
    const agentImage = await this.agentImageService.ensureImageExists(agentType, config.forceRebuild);
    this.logger.log(`Using agent image: ${agentImage}`);

    // Create Secret first
    await this.createSecret(secretName, config);

    // Create Pod
    // Sanitize label values - K8s labels can only contain alphanumeric, '-', '_', '.'
    const sanitizeLabel = (value: string): string =>
      value.replace(/[^a-zA-Z0-9\-_.]/g, '-').replace(/^-+|-+$/g, '');

    const pod: k8s.V1Pod = {
      metadata: {
        name: podName,
        labels: {
          app: 'stella-ai-agent',
          agentId: config.agentId,
          sessionId: config.sessionId,
          projectId: config.projectId,
          agentName: sanitizeLabel(config.agentName),
          agentType: agentType,
        },
      },
      spec: {
        restartPolicy: 'Never',
        // Production-only: Override DNS to bypass corporate SSL inspection (UZH network)
        // Uses CUSTOM_DNS_SERVERS (e.g., 8.8.8.8) with K8s search domains for service discovery
        ...(this.getProductionDnsConfig()),
        // Pod-level security: run as non-root user
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
        },
        containers: [
          {
            name: 'agent',
            image: agentImage,
            imagePullPolicy: this.imagePullPolicy as any,
            // Container-level security: prevent privilege escalation, drop capabilities
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: {
                drop: ['ALL'],
              },
            },
            // Run agent module (config from environment variables)
            // stella-light-agent -> stella_light_agent, stella-v2-agent -> stella_v2_agent
            command: ['python', '-m', agentType.replace(/-/g, '_')],
            envFrom: [
              {
                secretRef: {
                  name: secretName,
                },
              },
            ],
            // Build deterministic env injection payload via shared utility (also used by tests).
            env: buildPodEnvVars({
              agentId: config.agentId,
              sessionId: config.sessionId,
              agentName: config.agentName,
              agentIcon: config.agentIcon,
              agentType,
              grpcServerAddress: this.grpcServerAddress,
              sttServiceAddress: this.configService.get<string>('STT_SERVICE_ADDRESS', 'stt-service:50051'),
              ttsServiceAddress: this.configService.get<string>('TTS_SERVICE_ADDRESS', 'tts-service:50052'),
              stateMachineAddress: this.configService.get<string>('STATE_MACHINE_ADDRESS', 'session-management-server:50051'),
              nodeEnv: process.env.NODE_ENV || 'local',
            }),
            resources: {
              requests: {
                memory: '512Mi',
                cpu: '250m',
                // Note: Agents do NOT need GPU - they communicate with STT/TTS services via gRPC
                // The STT and TTS services have GPU access via runtimeClassName: nvidia
              },
              limits: {
                memory: memoryLimit,
                cpu: cpuLimit,
              },
            },
          },
        ],
      },
    };

    try {
      await this.k8sApi.createNamespacedPod({ namespace: this.namespace, body: pod });
      this.logger.log(`Created pod ${podName} in namespace ${this.namespace}`);
      return { podName, secretName };
    } catch (error) {
      this.logger.error(`Failed to create pod: ${error.message}`);
      // Clean up secret if pod creation failed
      await this.deleteSecret(secretName).catch(() => {});
      throw error;
    }
  }

  private async createSecret(secretName: string, config: AgentPodConfig): Promise<void> {
    // resolvedEnvVars is pre-merged by the caller (AgentsService) via EnvVarTemplatesService.resolveEnvVars().
    // KubernetesService has no knowledge of templates or encryption — it just spreads the final map.
    const secret: k8s.V1Secret = {
      metadata: {
        name: secretName,
        labels: {
          agentId: config.agentId,
          sessionId: config.sessionId,
          projectId: config.projectId,
        },
      },
      type: 'Opaque',
      // Shared utility ensures test and runtime payload generation stay aligned.
      stringData: buildSecretStringData({
        agentId: config.agentId,
        livekitUrl: config.livekitUrl,
        livekitApiKey: config.livekitApiKey,
        livekitApiSecret: config.livekitApiSecret,
        roomName: config.roomName,
        ttsProvider: config.ttsProvider,
        agentConfig: config.agentConfig || {},
        customEnvVars: config.resolvedEnvVars,
      }),
    };

    try {
      await this.k8sApi.createNamespacedSecret({ namespace: this.namespace, body: secret });
      this.logger.log(`Created secret ${secretName} with ${Object.keys(config.resolvedEnvVars).length} custom env vars`);
    } catch (error) {
      this.logger.error(`Failed to create secret: ${error.message}`);
      throw error;
    }
  }

  async deletePod(podName: string): Promise<void> {
    try {
      await this.k8sApi.deleteNamespacedPod({
        name: podName,
        namespace: this.namespace,
        gracePeriodSeconds: 0  // Force immediate termination (SIGKILL)
      });
      this.logger.log(`Deleted pod ${podName} from namespace ${this.namespace}`);
    } catch (error) {
      if (error.response?.statusCode === 404) {
        this.logger.warn(`Pod ${podName} not found`);
      } else {
        this.logger.error(`Failed to delete pod: ${error.message}`);
        throw error;
      }
    }
  }

  async deleteSecret(secretName: string): Promise<void> {
    try {
      await this.k8sApi.deleteNamespacedSecret({ name: secretName, namespace: this.namespace });
      this.logger.log(`Deleted secret ${secretName} from namespace ${this.namespace}`);
    } catch (error) {
      if (error.response?.statusCode === 404) {
        this.logger.warn(`Secret ${secretName} not found`);
      } else {
        this.logger.error(`Failed to delete secret: ${error.message}`);
      }
    }
  }

  async deleteConfigMap(configMapName: string): Promise<void> {
    try {
      await this.k8sApi.deleteNamespacedConfigMap({ name: configMapName, namespace: this.namespace });
      this.logger.log(`Deleted configmap ${configMapName} from namespace ${this.namespace}`);
    } catch (error) {
      if (error.response?.statusCode === 404) {
        this.logger.warn(`ConfigMap ${configMapName} not found`);
      } else {
        this.logger.error(`Failed to delete configmap: ${error.message}`);
      }
    }
  }

  async getPodStatus(podName: string): Promise<any> {
    try {
      const response = await this.k8sApi.readNamespacedPod({ name: podName, namespace: this.namespace });
      return {
        phase: response.status?.phase,
        conditions: response.status?.conditions,
        containerStatuses: response.status?.containerStatuses,
      };
    } catch (error) {
      if (error.response?.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async getPodLogs(podName: string): Promise<string> {
    try {
      const response = await this.k8sApi.readNamespacedPodLog({
        name: podName,
        namespace: this.namespace,
        tailLines: 100,
      });
      return typeof response === 'string' ? response : String(response);
    } catch (error) {
      if (error.response?.statusCode === 404) {
        return '';
      }
      throw error;
    }
  }

  /**
   * Batch-query K8s Metrics API for all agent pods.
   * Returns a map of agentId → { cpuMillicores, memoryBytes }.
   * Gracefully returns empty map if metrics-server is unavailable.
   */
  async getAgentPodMetrics(): Promise<Map<string, { cpuMillicores: number; memoryBytes: number }>> {
    const result = new Map<string, { cpuMillicores: number; memoryBytes: number }>();

    try {
      const response = await this.customObjectsApi.listNamespacedCustomObject({
        group: 'metrics.k8s.io',
        version: 'v1beta1',
        namespace: this.namespace,
        plural: 'pods',
        labelSelector: 'app=stella-ai-agent',
      });

      const body = response as any;
      const items = body?.items || [];

      for (const item of items) {
        const agentId = item.metadata?.labels?.agentId;
        if (!agentId) continue;

        const containers = item.containers || [];
        let totalCpuNano = 0;
        let totalMemoryBytes = 0;

        for (const container of containers) {
          const cpuUsage = container.usage?.cpu || '0';
          const memUsage = container.usage?.memory || '0';

          // Parse CPU: nanocores (e.g., "250000000n") → millicores
          if (cpuUsage.endsWith('n')) {
            totalCpuNano += parseInt(cpuUsage.slice(0, -1), 10);
          } else if (cpuUsage.endsWith('m')) {
            totalCpuNano += parseInt(cpuUsage.slice(0, -1), 10) * 1_000_000;
          } else {
            // Plain number = cores
            totalCpuNano += parseFloat(cpuUsage) * 1_000_000_000;
          }

          // Parse memory: Ki, Mi, Gi → bytes
          if (memUsage.endsWith('Ki')) {
            totalMemoryBytes += parseInt(memUsage.slice(0, -2), 10) * 1024;
          } else if (memUsage.endsWith('Mi')) {
            totalMemoryBytes += parseInt(memUsage.slice(0, -2), 10) * 1024 * 1024;
          } else if (memUsage.endsWith('Gi')) {
            totalMemoryBytes += parseFloat(memUsage.slice(0, -2)) * 1024 * 1024 * 1024;
          } else {
            totalMemoryBytes += parseInt(memUsage, 10) || 0;
          }
        }

        result.set(agentId, {
          cpuMillicores: Math.round(totalCpuNano / 1_000_000),
          memoryBytes: totalMemoryBytes,
        });
      }
    } catch (error) {
      // Graceful fallback: metrics-server may not be available
      this.logger.warn(`Failed to fetch agent pod metrics (metrics-server may be unavailable): ${error.message}`);
    }

    return result;
  }

  async streamPodLogs(podName: string, callback: (chunk: string) => void, onError?: (error: Error) => void): Promise<() => void> {
    // Return a cleanup function to stop the stream
    let intervalId: NodeJS.Timeout | null = null;
    let lastLogLength = 0;

    try {
      // Poll for new logs every 2 seconds
      intervalId = setInterval(async () => {
        try {
          const response = await this.k8sApi.readNamespacedPodLog({
            name: podName,
            namespace: this.namespace,
            tailLines: 1000, // Get last 1000 lines for full log history
          });

          const logs = typeof response === 'string' ? response : String(response);

          // Only send new logs (compare by length to avoid sending duplicates)
          if (logs.length > lastLogLength) {
            callback(logs);
            lastLogLength = logs.length;
          }
        } catch (error) {
          if (error.response?.statusCode === 404) {
            // Pod not found, stop streaming
            if (intervalId) clearInterval(intervalId);
            if (onError) onError(new Error('Pod not found'));
          } else {
            this.logger.error(`Error streaming logs: ${error.message}`);
            if (onError) onError(error);
          }
        }
      }, 2000);

      // Return cleanup function
      return () => {
        if (intervalId) {
          clearInterval(intervalId);
          this.logger.log(`Stopped streaming logs for pod ${podName}`);
        }
      };
    } catch (error) {
      this.logger.error(`Failed to start log stream: ${error.message}`);
      throw error;
    }
  }
}
