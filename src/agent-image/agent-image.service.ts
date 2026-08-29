import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec, ExecException } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createHash, Hash } from 'crypto';
import { AgentTypeService, AgentTypeInfo as DbAgentTypeInfo } from '../agent-type/agent-type.service';

const execAsync = promisify(exec);

export interface AgentImageConfig {
  imageName: string;
  dockerfilePath: string;
  contextPath: string;
  tag: string;
}

// Extended type info for gallery display
export interface AgentTypeInfo {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  version: string;
  isBuiltIn: boolean;
  capabilities: string[];
  defaultConfig: Record<string, unknown>;
  configSchema: Record<string, unknown> | null;  // JSON Schema for agent config (includes x-stella-* extensions)
}

@Injectable()
export class AgentImageService {
  private readonly logger = new Logger(AgentImageService.name);
  private readonly workspaceRoot: string;
  private readonly isProduction: boolean;  // Production uses K3s (needs containerd import)
  private readonly isRunningInK8s: boolean;
  private readonly hasDockerSocket: boolean;
  // Explicit container runtime for the readiness probe. Decoupled from NODE_ENV so
  // a non-k3s "production" deploy doesn't get stuck NotReady on a missing k3s CLI.
  private readonly containerRuntime: 'k3s' | 'docker' | 'none';

  // How many historical cfg-* tags to keep per agent image (newest first).
  // Every source change mints a new ~900MB tag and nothing else ever deletes the
  // old ones, so without a sweep the image store grows without bound.
  // Override with AGENT_IMAGE_KEEP_VERSIONS.
  private readonly keepConfigImageVersions: number;

  // Registry of known agent types and their build contexts
  // Paths are relative to stella-backend/ directory (the new context)
  private readonly agentRegistry: Map<string, AgentImageConfig> = new Map([
    ['stella-light-agent', {
      imageName: 'stella-light-agent',
      dockerfilePath: 'agents/stella-light-agent/Dockerfile',
      contextPath: '.',
      tag: 'latest',
    }],
    ['stella-v2-agent', {
      imageName: 'stella-v2-agent',
      dockerfilePath: 'agents/stella-v2-agent/Dockerfile',
      contextPath: '.',
      tag: 'latest',
    }],
  ]);

  // Track images currently being built to avoid duplicate builds
  private readonly buildingImages: Map<string, Promise<string>> = new Map();

  constructor(
    private configService: ConfigService,
    private agentTypeService: AgentTypeService,
  ) {
    // Detect if running inside a K8s pod
    this.isRunningInK8s = !!process.env.KUBERNETES_SERVICE_HOST;

    // Production (K3s) vs Local (OrbStack/Docker Desktop)
    // - Production: Uses K3s with containerd, needs image import after Docker build
    // - Local: Uses OrbStack/Docker Desktop with shared Docker daemon, no import needed
    const nodeEnv = this.configService.get<string>('NODE_ENV', 'local');
    this.isProduction = nodeEnv === 'production';

    // CONTAINER_RUNTIME defaults to 'k3s' only for the production-in-K8s case
    // (the original implicit assumption); otherwise 'none' so readiness stays green.
    const explicitRuntime = this.configService.get<string>('CONTAINER_RUNTIME');
    if (explicitRuntime === 'k3s' || explicitRuntime === 'docker' || explicitRuntime === 'none') {
      this.containerRuntime = explicitRuntime;
    } else {
      this.containerRuntime = this.isProduction && !!process.env.KUBERNETES_SERVICE_HOST ? 'k3s' : 'none';
    }

    const keepVersions = parseInt(this.configService.get<string>('AGENT_IMAGE_KEEP_VERSIONS', '3'), 10);
    this.keepConfigImageVersions = Number.isFinite(keepVersions) && keepVersions > 0 ? keepVersions : 3;

    // In K8s, use the mounted workspace path from AGENT_WORKSPACE_ROOT env var
    // Otherwise, compute it relative to this file's location
    if (this.isRunningInK8s && process.env.AGENT_WORKSPACE_ROOT) {
      this.workspaceRoot = process.env.AGENT_WORKSPACE_ROOT;
    } else {
      // Local development: workspace root is stella-backend/ directory
      // (agents are now inside stella-backend/agents/)
      this.workspaceRoot = path.resolve(__dirname, '../../../');
    }

    // Check if Docker socket is available (either native or mounted in K8s)
    this.hasDockerSocket = this.checkDockerSocket();

    this.logger.log(`AgentImageService initialized`);
    this.logger.log(`Workspace root: ${this.workspaceRoot}`);
    this.logger.log(`Environment: ${nodeEnv} (${this.isProduction ? 'K3s/containerd' : 'OrbStack/Docker'})`);
    this.logger.log(`Container runtime (readiness probe): ${this.containerRuntime}`);
    this.logger.log(`Running in K8s: ${this.isRunningInK8s}`);
    this.logger.log(`Docker socket available: ${this.hasDockerSocket}`);
    this.logger.log(`Retained cfg-* image versions: ${this.keepConfigImageVersions}`);

    if (this.isRunningInK8s && !this.hasDockerSocket) {
      this.logger.warn(`Running inside K8s pod without Docker socket - images must be pre-built`);
    }

    // Surface containerd reachability at boot so a stale-socket scenario fails loud,
    // not silently the first time a user tries to create an agent.
    if (this.containerRuntime === 'k3s') {
      this.checkContainerdHealth()
        .then((result) => {
          if (result.ok) {
            this.logger.log('Containerd reachable at startup');
          } else {
            this.logger.error(`Containerd unreachable at startup: ${result.error}`);
          }
        })
        .catch((err) => {
          this.logger.error(`Containerd boot check threw: ${(err as Error).message?.trim()}`);
        });
    }
  }

  /**
   * Ping K3s containerd via `k3s ctr version`. Used by the readiness probe
   * so the pod is taken out of rotation if the host socket goes stale.
   */
  async checkContainerdHealth(): Promise<{ ok: boolean; error?: string }> {
    if (this.containerRuntime !== 'k3s') {
      return { ok: true };
    }
    try {
      await execAsync('k3s ctr version', { timeout: 5000 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message?.trim() };
    }
  }

  /**
   * Check if Docker is available for building images.
   * Runs synchronously at startup to test if Docker CLI works.
   */
  private checkDockerSocket(): boolean {
    const { execSync } = require('child_process');
    try {
      // Test if docker command is available and can connect
      execSync('docker version', { stdio: 'pipe', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Register a new agent type for on-demand building.
   */
  registerAgentType(agentType: string, config: AgentImageConfig): void {
    this.agentRegistry.set(agentType, config);
    this.logger.log(`Registered agent type: ${agentType} -> ${config.imageName}:${config.tag}`);
  }

  /**
   * Get all registered agent types.
   */
  getRegisteredAgentTypes(): string[] {
    return Array.from(this.agentRegistry.keys());
  }

  /**
   * Get all registered agent types with metadata from database.
   * Throws error if database is not seeded - no fallback to prevent silent failures.
   */
  async getAgentTypesWithInfo(): Promise<AgentTypeInfo[]> {
    const dbTypes = await this.agentTypeService.getAgentTypesForGallery();

    if (dbTypes.length === 0) {
      this.logger.error('No agent types found in database. Database must be seeded.');
      throw new Error(
        'No agent types found. Please run: npx prisma db seed\n' +
        'This will read agent.yaml manifests from agents/ directory and populate the database.'
      );
    }

    this.logger.debug(`Loaded ${dbTypes.length} agent types from database`);
    return dbTypes;
  }

  /**
   * Ensure agent image exists, building if necessary.
   * Returns the full image name (e.g., "stella-agent:latest")
   *
   * When running inside K8s with Docker socket mounted, we can build images.
   * Without Docker socket, we assume images are pre-built on the host.
   *
   * This method is idempotent - if the image is already being built,
   * it will wait for that build to complete rather than starting a new one.
   */
  async ensureImageExists(agentType: string, forceRebuild = false): Promise<string> {
    const config = this.agentRegistry.get(agentType);
    if (!config) {
      throw new Error(`Unknown agent type: ${agentType}. Available types: ${this.getRegisteredAgentTypes().join(', ')}`);
    }

    // Legacy/static tag for environments where we cannot build locally.
    // (e.g., no Docker socket mounted and images are expected to be pre-built externally)
    const legacyImageName = `${config.imageName}:${config.tag}`;

    // If no Docker socket available, we can't build - assume images are pre-built
    if (!this.hasDockerSocket) {
      this.logger.log(`No Docker socket available - assuming image ${legacyImageName} is pre-built`);
      return legacyImageName;
    }

    const fingerprint = await this.computeBuildFingerprint(agentType, config);
    const fullImageName = `${config.imageName}:cfg-${fingerprint.slice(0, 12)}`;
    this.logger.debug(`Resolved image for ${agentType}: ${fullImageName}`);

    // If force rebuild, skip cache check
    if (!forceRebuild) {
      // Check if image exists
      if (await this.imageExists(fullImageName)) {
        this.logger.log(`Image ${fullImageName} already exists (cached)`);
        return fullImageName;
      }
    }

    // Check if this image is currently being built
    const existingBuild = this.buildingImages.get(fullImageName);
    if (existingBuild) {
      this.logger.log(`Image ${fullImageName} is already being built, waiting...`);
      return existingBuild;
    }

    // Build the image and return the image name when done.
    // Optimization: if the :latest image is already in the runtime (pre-built
    // during deployment), tag it directly instead of running a full docker
    // build + docker save + ctr import (~950MB round-trip).
    const buildPromise = (async (): Promise<string> => {
      if (!forceRebuild) {
        const tagged = await this.tryTagFromLatest(config, fullImageName);
        if (tagged) {
          await this.pruneOldConfigImages(config, fullImageName);
          return fullImageName;
        }
      }
      // If tagging failed (e.g., ctr not available inside K8s pod),
      // fall back to the pre-built :latest image rather than blocking pod creation.
      try {
        await this.buildAndImportImage(config, fullImageName, forceRebuild);
        await this.pruneOldConfigImages(config, fullImageName);
        return fullImageName;
      } catch (error) {
        this.logger.warn(
          `Image build/import failed: ${error.message}. ` +
          `Falling back to pre-built image ${legacyImageName}`,
        );
        return legacyImageName;
      }
    })();

    this.buildingImages.set(fullImageName, buildPromise);

    try {
      return await buildPromise;
    } finally {
      this.buildingImages.delete(fullImageName);
    }
  }

  /**
   * Check if Docker image exists locally.
   *
   * On macOS: Checks Docker daemon
   * On Linux (K3s): Checks both Docker and K3s containerd
   */
  private async imageExists(imageName: string): Promise<boolean> {
    try {
      // Check Docker daemon first
      const { stdout } = await execAsync(`docker images -q ${imageName}`);
      const existsInDocker = stdout.trim().length > 0;

      // On Linux with K3s, also check containerd
      if (this.isProduction) {
        const existsInK3s = await this.imageExistsInK3s(imageName);
        // Return true only if image exists in BOTH Docker and K3s
        // (if it's in Docker but not K3s, we need to import it)
        return existsInDocker && existsInK3s;
      }

      return existsInDocker;
    } catch (error) {
      this.logger.warn(`Error checking image existence: ${error.message}`);
      return false;
    }
  }

  /**
   * Build Docker image using Docker CLI.
   *
   * Platform behavior:
   * - macOS (OrbStack/Docker Desktop): Images built via Docker socket are automatically
   *   available to the Kubernetes cluster (no import needed)
   * - Linux (K3s): Images must be imported into K3s containerd after building
   */
  private async buildAndImportImage(
    config: AgentImageConfig,
    fullImageName: string,
    forceRebuild: boolean,
  ): Promise<void> {
    const dockerfilePath = path.join(this.workspaceRoot, config.dockerfilePath);
    const contextPath = path.join(this.workspaceRoot, config.contextPath);
    const noCacheFlag = forceRebuild ? '--no-cache' : '';

    this.logger.log(`Building image ${fullImageName}...`);
    this.logger.log(`  Dockerfile: ${dockerfilePath}`);
    this.logger.log(`  Context: ${contextPath}`);
    this.logger.log(`  Workspace root: ${this.workspaceRoot}`);
    this.logger.log(`  Environment: ${this.isProduction ? 'Production (K3s)' : 'Local (OrbStack/Docker)'}`);
    if (forceRebuild) {
      this.logger.log(`  Force rebuild: enabled (--no-cache)`);
    }

    const startTime = Date.now();

    try {
      // Build with Docker
      const buildCmd = `docker build ${noCacheFlag} -t ${fullImageName} -f ${dockerfilePath} ${contextPath}`;
      this.logger.log(`Executing: ${buildCmd}`);

      const { stdout, stderr } = await execAsync(buildCmd, {
        timeout: 600000, // 10 min timeout for builds
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer for build output
      });

      if (stderr && !stderr.includes('Successfully')) {
        this.logger.debug(`Build stderr: ${stderr}`);
      }

      const buildTime = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(`Image ${fullImageName} built successfully in ${buildTime}s`);

      // On Linux with K3s, we need to import the image into containerd
      // On macOS with OrbStack/Docker Desktop, images are automatically available
      if (this.isProduction) {
        await this.importToK3s(fullImageName);
      }
    } catch (error) {
      const execError = error as ExecException & { stdout?: string; stderr?: string };
      this.logger.error(`Failed to build image ${fullImageName}: ${execError.message}`);
      if (execError.stderr) {
        this.logger.error(`Build stderr: ${execError.stderr}`);
      }
      throw error;
    }
  }

  /**
   * Try to create the cfg-tagged image by tagging the existing :latest image.
   * On K3s, tags directly in containerd to avoid the expensive docker save/import.
   * Returns true if successful, false if caller should fall back to full build.
   */
  private async tryTagFromLatest(
    config: AgentImageConfig,
    fullImageName: string,
  ): Promise<boolean> {
    const latestImage = `${config.imageName}:${config.tag}`;

    try {
      // Tag in Docker (instant — same layers)
      const dockerHasLatest = await (async () => {
        try {
          const { stdout } = await execAsync(`docker images -q ${latestImage}`, { timeout: 5000 });
          return stdout.trim().length > 0;
        } catch { return false; }
      })();

      if (!dockerHasLatest) {
        this.logger.debug(`Fast tag: ${latestImage} not found in Docker, skipping`);
        return false;
      }

      await execAsync(`docker tag ${latestImage} ${fullImageName}`, { timeout: 10000 });

      if (this.isProduction) {
        // Tag directly in K3s containerd (avoids 950MB save/import round-trip)
        const latestRef = `docker.io/library/${latestImage}`;
        const cfgRef = `docker.io/library/${fullImageName}`;

        try {
          await execAsync(`k3s ctr images tag ${latestRef} ${cfgRef}`, { timeout: 10000 });
        } catch {
          await execAsync(
            `ctr --address /run/k3s/containerd/containerd.sock -n k8s.io images tag ${latestRef} ${cfgRef}`,
            { timeout: 10000 },
          );
        }
      }

      this.logger.log(`Fast-tagged ${fullImageName} from ${latestImage} (skipped full build)`);
      return true;
    } catch (error) {
      this.logger.warn(`Fast tag failed, falling back to full build: ${error.message}`);
      return false;
    }
  }

  /**
   * Import a Docker image into K3s containerd (Linux only).
   *
   * K3s uses containerd as its container runtime, so images built with Docker
   * need to be exported and imported into containerd.
   */
  private async importToK3s(imageName: string): Promise<void> {
    this.logger.log(`Importing ${imageName} into K3s containerd...`);

    const tarPath = `/tmp/${imageName.replace(':', '-').replace('/', '-')}.tar`;

    try {
      // Export from Docker to tar file
      this.logger.log(`Exporting image to ${tarPath}...`);
      await execAsync(`docker save ${imageName} -o ${tarPath}`, { timeout: 120000 });

      // Import into K3s containerd
      // Note: When running inside K3s pod with hostPID and proper mounts, we can use ctr directly
      // The k3s ctr command wraps containerd's ctr with the right socket path
      this.logger.log(`Importing into K3s containerd...`);
      try {
        // Use k3s ctr (works when k3s binary is mounted into the container)
        await execAsync(`k3s ctr images import ${tarPath}`, { timeout: 120000 });
      } catch (k3sErr) {
        this.logger.warn(`k3s ctr import failed (${k3sErr.message?.trim()}), falling back to ctr binary`);
        await execAsync(`ctr --address /run/k3s/containerd/containerd.sock -n k8s.io images import ${tarPath}`, { timeout: 120000 });
      }

      this.logger.log(`Successfully imported ${imageName} into K3s containerd`);
    } catch (error) {
      this.logger.error(`Failed to import image into K3s: ${error.message}`);
      throw error;
    } finally {
      // Always drop the export, including when the import above threw. Otherwise
      // every failed import strands a ~900MB tarball on the host disk forever.
      await execAsync(`rm -f ${tarPath}`).catch(() => undefined);
    }
  }

  /**
   * Check if image exists in K3s containerd.
   */
  private async imageExistsInK3s(imageName: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`k3s ctr images ls -q | grep -E "^docker.io/library/${imageName}$"`, {
        timeout: 10000,
      });
      return stdout.trim().length > 0;
    } catch (k3sErr) {
      this.logger.warn(`k3s ctr image lookup failed (${k3sErr.message?.trim()}), falling back to ctr binary`);
      try {
        const { stdout } = await execAsync(`ctr --address /run/k3s/containerd/containerd.sock -n k8s.io images ls -q | grep -E "^docker.io/library/${imageName}$"`, {
          timeout: 10000,
        });
        return stdout.trim().length > 0;
      } catch {
        return false;
      }
    }
  }

  /**
   * Force rebuild an agent image.
   */
  async rebuildImage(agentType: string): Promise<string> {
    return this.ensureImageExists(agentType, true);
  }

  /**
   * Remove an agent image from local cache.
   */
  async removeImage(agentType: string): Promise<void> {
    const config = this.agentRegistry.get(agentType);
    if (!config) {
      throw new Error(`Unknown agent type: ${agentType}`);
    }

    const imagesToRemove = new Set<string>([`${config.imageName}:${config.tag}`]);
    if (this.hasDockerSocket) {
      const fingerprint = await this.computeBuildFingerprint(agentType, config);
      imagesToRemove.add(`${config.imageName}:cfg-${fingerprint.slice(0, 12)}`);
    }

    for (const imageName of imagesToRemove) {
      this.logger.log(`Removing image ${imageName}...`);
      try {
        if (this.isProduction) {
          // Remove from K3s containerd
          try {
            await execAsync(`k3s ctr images rm docker.io/library/${imageName}`);
          } catch (k3sErr) {
            this.logger.warn(`k3s ctr image rm failed (${k3sErr.message?.trim()}), falling back to ctr binary`);
            await execAsync(`ctr --address /run/k3s/containerd/containerd.sock -n k8s.io images rm docker.io/library/${imageName}`);
          }
        }
        // Remove from Docker
        await execAsync(`docker rmi ${imageName}`);
        this.logger.log(`Removed image ${imageName}`);
      } catch (error) {
        this.logger.warn(`Error removing image ${imageName}: ${error.message}`);
      }
    }
  }

  /**
   * Delete stale cfg-* tags for an agent image, keeping the newest
   * `keepConfigImageVersions` plus anything a live workload still references.
   *
   * The cfg tag fingerprints the Dockerfile and its COPY sources, so every source
   * change strands the previous tag. removeImage() only ever drops the tag for the
   * *current* fingerprint, so nothing reclaimed the history until this sweep.
   *
   * Safe against the auto-pause/wake flow: resuming an agent goes through
   * restartAgent() -> createAgentPod() -> ensureImageExists(), which recomputes the
   * fingerprint from current source. A resumed agent therefore always lands on the
   * current tag, never a pruned one. Only pods that are still alive can depend on
   * an older tag, and those are protected below.
   *
   * Fails safe: if the in-use set cannot be determined, nothing is removed.
   */
  private async pruneOldConfigImages(config: AgentImageConfig, currentImageName: string): Promise<void> {
    try {
      const tags = await this.listConfigImageTags(config);
      if (tags.length <= this.keepConfigImageVersions) {
        return;
      }

      const inUse = await this.listInUseImageRefs();
      if (!inUse) {
        this.logger.warn(
          `Skipping cfg-* prune for ${config.imageName}: could not determine which images are in use`,
        );
        return;
      }

      const protectedRefs = new Set<string>([
        currentImageName,
        `${config.imageName}:${config.tag}`,
        ...inUse,
      ]);

      // listConfigImageTags() returns newest-first, so slice() keeps the newest N.
      const stale = tags
        .slice(this.keepConfigImageVersions)
        .filter((ref) => !protectedRefs.has(ref));

      if (stale.length === 0) {
        return;
      }

      for (const ref of stale) {
        await this.removeImageRef(ref);
      }
      this.logger.log(
        `Pruned ${stale.length} stale ${config.imageName} cfg-* image(s), ` +
        `kept the ${this.keepConfigImageVersions} newest`,
      );
    } catch (error) {
      // Never let housekeeping block an agent spawn.
      this.logger.warn(`cfg-* prune for ${config.imageName} failed: ${(error as Error).message?.trim()}`);
    }
  }

  /**
   * List cfg-* tags for an agent image as `name:tag`, newest first
   * (`docker images` sorts by creation time descending).
   */
  private async listConfigImageTags(config: AgentImageConfig): Promise<string[]> {
    const { stdout } = await execAsync(
      `docker images --filter=reference='${config.imageName}:cfg-*' --format '{{.Repository}}:{{.Tag}}'`,
      { timeout: 15000 },
    );
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  /**
   * Images referenced by live workloads, normalised to `name:tag`.
   *
   * The cluster is asked first: a pod spec pins its image even while the pod is
   * being recreated, which the local container list would miss. Falls back to the
   * Docker container list (enough locally, where K8s shares the Docker daemon).
   *
   * Returns null when no source can be reached, which disables pruning entirely.
   */
  private async listInUseImageRefs(): Promise<Set<string> | null> {
    const jsonPath =
      '{range .items[*]}' +
      '{range .spec.containers[*]}{.image}{"\\n"}{end}' +
      '{range .spec.initContainers[*]}{.image}{"\\n"}{end}' +
      '{end}';

    const sources = [
      `kubectl get pods -A -o jsonpath='${jsonPath}'`,
      `k3s kubectl get pods -A -o jsonpath='${jsonPath}'`,
      `docker ps -a --format '{{.Image}}'`,
    ];

    for (const cmd of sources) {
      try {
        const { stdout } = await execAsync(cmd, { timeout: 15000 });
        const refs = stdout
          .split('\n')
          .map((line) => this.normalizeImageRef(line))
          .filter(Boolean);
        if (refs.length > 0) {
          return new Set(refs);
        }
      } catch {
        // Unreachable source - try the next one.
      }
    }

    return null;
  }

  /**
   * Normalise an image reference to `name:tag` so refs from kubectl, ctr and
   * docker compare equal.
   */
  private normalizeImageRef(raw: string): string {
    const ref = raw.trim().replace(/^docker\.io\/library\//, '');
    if (!ref || ref.includes('@')) {
      return '';
    }
    return ref.includes(':') ? ref : `${ref}:latest`;
  }

  /**
   * Remove one image ref from every runtime that may hold it.
   *
   * Deliberately never uses `docker rmi -f`: the daemon's own in-use check is the
   * last line of defence behind listInUseImageRefs().
   */
  private async removeImageRef(imageName: string): Promise<void> {
    if (this.isProduction) {
      try {
        await execAsync(`k3s ctr images rm docker.io/library/${imageName}`, { timeout: 30000 });
      } catch (k3sErr) {
        this.logger.warn(`k3s ctr image rm failed (${(k3sErr as Error).message?.trim()}), falling back to ctr binary`);
        try {
          await execAsync(
            `ctr --address /run/k3s/containerd/containerd.sock -n k8s.io images rm docker.io/library/${imageName}`,
            { timeout: 30000 },
          );
        } catch (ctrErr) {
          this.logger.warn(`Could not remove ${imageName} from containerd: ${(ctrErr as Error).message?.trim()}`);
        }
      }
    }

    try {
      await execAsync(`docker rmi ${imageName}`, { timeout: 30000 });
      this.logger.log(`Removed stale image ${imageName}`);
    } catch (error) {
      this.logger.warn(`Could not remove ${imageName} from Docker: ${(error as Error).message?.trim()}`);
    }
  }

  /**
   * Compute deterministic fingerprint for container-relevant build inputs.
   * Any Dockerfile/COPY source change creates a new image tag automatically.
   */
  private async computeBuildFingerprint(agentType: string, config: AgentImageConfig): Promise<string> {
    const dockerfilePath = path.join(this.workspaceRoot, config.dockerfilePath);
    const hash = createHash('sha256');
    hash.update('agent-image-fingerprint:v1\n');
    hash.update(`agentType:${agentType}\n`);
    hash.update(`dockerfile:${config.dockerfilePath}\n`);
    hash.update(`context:${config.contextPath}\n`);

    const dockerfileContent = await fs.readFile(dockerfilePath, 'utf-8');
    hash.update(dockerfileContent);

    const sourcePaths = new Set<string>([
      `agents/${agentType}`,
      'agents/stella-ai-agent-sdk',
      ...this.extractCopySources(dockerfileContent),
    ]);

    const sortedPaths = Array.from(sourcePaths).sort();
    for (const relPath of sortedPaths) {
      if (!relPath || relPath.includes('$')) continue;
      const normalizedRelPath = relPath.replace(/\\/g, '/');
      const absPath = path.resolve(this.workspaceRoot, normalizedRelPath);
      if (!absPath.startsWith(this.workspaceRoot)) continue;
      await this.hashPathRecursive(hash, absPath, normalizedRelPath);
    }

    return hash.digest('hex');
  }

  /**
   * Extract local source paths from Dockerfile COPY statements.
   * Supports:
   * - COPY a b /dest
   * - COPY --chown=1000:1000 a b /dest
   * - COPY ["a", "b", "/dest"]
   */
  private extractCopySources(dockerfileContent: string): string[] {
    const sources: string[] = [];
    const logicalLines: string[] = [];
    let current = '';

    for (const rawLine of dockerfileContent.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.endsWith('\\')) {
        current += `${line.slice(0, -1).trim()} `;
      } else {
        current += line;
        logicalLines.push(current.trim());
        current = '';
      }
    }
    if (current.trim()) {
      logicalLines.push(current.trim());
    }

    for (const line of logicalLines) {
      if (!line.toUpperCase().startsWith('COPY ')) continue;
      const args = line.slice(5).trim();

      if (args.startsWith('[')) {
        try {
          const values = JSON.parse(args) as string[];
          if (Array.isArray(values) && values.length >= 2) {
            sources.push(...values.slice(0, -1));
          }
        } catch {
          // Ignore malformed JSON array syntax and fall back to defaults.
        }
        continue;
      }

      const parts = args.split(/\s+/).filter(Boolean);
      while (parts.length > 0 && parts[0].startsWith('--')) {
        parts.shift();
      }
      if (parts.length >= 2) {
        sources.push(...parts.slice(0, -1));
      }
    }

    return sources;
  }

  /**
   * Recursively hash file tree so config/content changes invalidate build cache key.
   */
  private async hashPathRecursive(hash: Hash, absPath: string, logicalPath: string): Promise<void> {
    try {
      const stat = await fs.stat(absPath);
      if (stat.isDirectory()) {
        hash.update(`dir:${logicalPath}\n`);
        const entries = await fs.readdir(absPath, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          const childAbs = path.join(absPath, entry.name);
          const childLogical = `${logicalPath}/${entry.name}`;
          await this.hashPathRecursive(hash, childAbs, childLogical);
        }
        return;
      }

      if (stat.isFile()) {
        hash.update(`file:${logicalPath}:${stat.size}\n`);
        hash.update(await fs.readFile(absPath));
      }
    } catch {
      hash.update(`missing:${logicalPath}\n`);
    }
  }
}
