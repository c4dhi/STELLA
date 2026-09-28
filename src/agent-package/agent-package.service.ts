import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import AdmZip from 'adm-zip'
import { ManifestValidator } from './validators/manifest.validator.js'
import { DockerfileValidator } from './validators/dockerfile.validator.js'
import { StorageService } from '../storage/storage.service.js'
import {
  AgentManifest,
  PackageValidationResult,
} from './agent-manifest.types.js'

const REQUIRED_FILES = ['agent.yaml']
const MIN_SDK_VERSION = '0.4.0'

// Mirrors VERDICT_ACTIONS in the agent's expert base.py. Validated at publish
// time so a typo'd action can't reach runtime (where it is silently coerced to
// "inform", downgrading a deterministic safety directive with no trace).
const VALID_VERDICT_ACTIONS = new Set(['inform', 'prepend', 'override', 'short_circuit'])

@Injectable()
export class AgentPackageService {
  private readonly logger = new Logger(AgentPackageService.name)

  constructor(
    private manifestValidator: ManifestValidator,
    private dockerfileValidator: DockerfileValidator,
    private storageService: StorageService,
  ) {}

  /**
   * Validate an agent package zip file.
   * Does not store the file - only validates contents.
   */
  async validatePackage(zipBuffer: Buffer): Promise<PackageValidationResult> {
    const errors: string[] = []
    const warnings: string[] = []
    const files: string[] = []

    // Parse zip file
    let zip: AdmZip
    try {
      zip = new AdmZip(zipBuffer)
    } catch (error) {
      return {
        valid: false,
        errors: [`Invalid zip file: ${error.message}`],
        warnings: [],
        files: [],
      }
    }

    // List all files in the zip
    const entries = zip.getEntries()
    for (const entry of entries) {
      if (!entry.isDirectory) {
        files.push(entry.entryName)
      }
    }

    // Check for required files
    for (const required of REQUIRED_FILES) {
      if (!this.fileExistsInZip(files, required)) {
        errors.push(`Missing required file: ${required}`)
      }
    }

    // Parse and validate manifest
    let manifest: AgentManifest | undefined
    const manifestEntry = this.findEntry(entries, 'agent.yaml')
    if (manifestEntry) {
      const manifestContent = manifestEntry.getData().toString('utf-8')
      const manifestResult = this.manifestValidator.validate(manifestContent)

      errors.push(...manifestResult.errors)
      warnings.push(...manifestResult.warnings)
      manifest = manifestResult.manifest
    }

    // If manifest specifies a Dockerfile, validate it
    if (manifest?.image?.dockerfile) {
      const dockerfilePath = manifest.image.dockerfile
      const dockerfileEntry = this.findEntry(entries, dockerfilePath)

      if (!dockerfileEntry) {
        errors.push(`Dockerfile not found: ${dockerfilePath}`)
      } else {
        const dockerfileContent = dockerfileEntry.getData().toString('utf-8')
        const dockerResult = this.dockerfileValidator.validate(dockerfileContent)

        errors.push(...dockerResult.errors)
        warnings.push(...dockerResult.warnings)
      }
    } else if (manifest && !manifest.image?.imageUrl) {
      // Check for default Dockerfile location
      const defaultDockerfile = this.findEntry(entries, 'Dockerfile')
      if (defaultDockerfile) {
        const dockerfileContent = defaultDockerfile.getData().toString('utf-8')
        const dockerResult = this.dockerfileValidator.validate(dockerfileContent)

        errors.push(...dockerResult.errors)
        warnings.push(...dockerResult.warnings)
      }
    }

    // Check for requirements.txt with SDK dependency
    const requirementsEntry = this.findEntry(entries, 'requirements.txt')
    if (requirementsEntry) {
      const requirementsContent = requirementsEntry.getData().toString('utf-8')
      const sdkCheck = this.validateSdkDependency(requirementsContent)

      if (!sdkCheck.found) {
        errors.push('requirements.txt must include stella-ai-agent-sdk')
      } else if (sdkCheck.version && !this.isVersionCompatible(sdkCheck.version, MIN_SDK_VERSION)) {
        warnings.push(
          `SDK version ${sdkCheck.version} may not be compatible; minimum recommended: ${MIN_SDK_VERSION}`,
        )
      }
    } else if (manifest?.image?.dockerfile) {
      warnings.push('No requirements.txt found; ensure SDK is installed in Dockerfile')
    }

    // Check for source directory structure
    if (manifest?.metadata?.slug) {
      const expectedPackage = manifest.metadata.slug.replace(/-/g, '_')
      const hasPackageDir = files.some(
        (f) => f.startsWith(`src/${expectedPackage}/`) || f.startsWith(`${expectedPackage}/`),
      )
      if (!hasPackageDir) {
        warnings.push(
          `Expected package directory src/${expectedPackage}/ not found`,
        )
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      manifest,
      files,
    }
  }

  /**
   * Store a validated package and return storage info.
   */
  async storePackage(
    zipBuffer: Buffer,
    filename: string,
  ): Promise<{ path: string; size: number; hash: string }> {
    const hash = StorageService.calculateHash(zipBuffer)
    const path = await this.storageService.upload(filename, zipBuffer)

    return {
      path,
      size: zipBuffer.length,
      hash,
    }
  }

  /**
   * Extract a specific file from a stored package.
   */
  async extractFile(storagePath: string, filePath: string): Promise<Buffer | null> {
    try {
      const zipBuffer = await this.storageService.download(storagePath)
      const zip = new AdmZip(zipBuffer)
      const entry = this.findEntry(zip.getEntries(), filePath)

      if (!entry) {
        return null
      }

      return entry.getData()
    } catch (error) {
      this.logger.error(`Failed to extract file: ${error.message}`)
      return null
    }
  }

  /**
   * Extract all files from a stored package to a temporary directory.
   * Returns the path to the extracted directory.
   */
  async extractPackage(storagePath: string): Promise<string> {
    const zipBuffer = await this.storageService.download(storagePath)
    const zip = new AdmZip(zipBuffer)

    // Create a unique temp directory
    const tempDir = `/tmp/agent-build-${Date.now()}-${Math.random().toString(36).slice(2)}`
    zip.extractAllTo(tempDir, true)

    return tempDir
  }

  /**
   * Parse manifest from stored package.
   */
  async parseManifest(storagePath: string): Promise<AgentManifest | null> {
    const manifestBuffer = await this.extractFile(storagePath, 'agent.yaml')
    if (!manifestBuffer) {
      return null
    }

    const result = this.manifestValidator.validate(manifestBuffer.toString('utf-8'))
    return result.manifest || null
  }

  /**
   * Check if SDK is in requirements.txt.
   */
  private validateSdkDependency(requirements: string): { found: boolean; version?: string } {
    const lines = requirements.split('\n')

    for (const line of lines) {
      const trimmed = line.trim()

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) continue

      // Check for stella-ai-agent-sdk
      if (trimmed.includes('stella-ai-agent-sdk')) {
        // Extract version if specified
        const versionMatch = trimmed.match(/stella-ai-agent-sdk[><=!~]*=?\s*([\d.]+)/)
        return {
          found: true,
          version: versionMatch ? versionMatch[1] : undefined,
        }
      }
    }

    return { found: false }
  }

  /**
   * Check if version meets minimum requirement.
   */
  private isVersionCompatible(version: string, minVersion: string): boolean {
    const vParts = version.split('.').map(Number)
    const minParts = minVersion.split('.').map(Number)

    for (let i = 0; i < Math.max(vParts.length, minParts.length); i++) {
      const v = vParts[i] || 0
      const min = minParts[i] || 0

      if (v > min) return true
      if (v < min) return false
    }

    return true
  }

  /**
   * Read the agent's declared default experts from config/experts/*.json inside the package.
   *
   * Capability-gated per expert: `task_extraction` rides on the "plans" capability,
   * the assessment experts ride on "experts". Returns the parsed expert objects (each
   * file = one expert: name/model/prompt/verdict_directives/…) for publishing onto
   * AgentType.expertDefaults, or null when none apply. Tolerant of a top-level package
   * folder (matches any path ending in config/experts/<name>.json).
   */
  readExpertDefaults(zipBuffer: Buffer, capabilities: unknown): Record<string, unknown>[] | null {
    const caps = Array.isArray(capabilities) ? (capabilities as string[]) : []
    const hasExperts = caps.includes('experts')
    const hasPlans = caps.includes('plans')
    if (!hasExperts && !hasPlans) return null

    let zip: AdmZip
    try {
      zip = new AdmZip(zipBuffer)
    } catch {
      return null
    }

    const matcher = /(^|\/)config\/experts\/[^/]+\.json$/i
    const experts: Record<string, unknown>[] = []
    const matching = zip
      .getEntries()
      .filter((e) => !e.isDirectory && matcher.test(e.entryName.replace(/^\.\//, '')))
      .sort((a, b) => a.entryName.localeCompare(b.entryName))

    const seenNames = new Set<string>()
    for (const entry of matching) {
      let parsed: unknown
      try {
        parsed = JSON.parse(entry.getData().toString('utf-8'))
      } catch (err) {
        throw new Error(`Invalid expert config ${entry.entryName}: ${(err as Error).message}`)
      }
      if (!parsed || typeof parsed !== 'object') continue
      const record = parsed as Record<string, unknown>
      const name = record.name

      // A nameless expert would publish as an unnamed row and collide on React
      // keys / arbitration lookup — reject it instead of silently shipping it.
      if (typeof name !== 'string' || name.trim() === '') {
        throw new Error(`Expert config ${entry.entryName} is missing a "name" field`)
      }
      // Two files declaring the same expert name → duplicate rows + key collisions.
      if (seenNames.has(name)) {
        throw new Error(
          `Duplicate expert name "${name}" across config/experts/*.json (${entry.entryName})`,
        )
      }
      seenNames.add(name)

      this.validateExpertVerdictActions(record, entry.entryName)

      const include = name === 'task_extraction' ? hasPlans : hasExperts
      if (include) experts.push(record)
    }

    return experts.length > 0 ? experts : null
  }

  /**
   * Publish-time validation of an expert's verdict_directives action enum.
   * Rejecting here keeps a typo'd action (e.g. "overide") from reaching runtime,
   * where it would be silently coerced to "inform" and quietly disable a
   * deterministic safety override.
   */
  private validateExpertVerdictActions(expert: Record<string, unknown>, where: string): void {
    const directives = expert.verdict_directives
    if (!directives || typeof directives !== 'object') return
    for (const [verdict, dir] of Object.entries(directives as Record<string, unknown>)) {
      if (!dir || typeof dir !== 'object') continue
      const action = (dir as Record<string, unknown>).action
      if (action !== undefined && !VALID_VERDICT_ACTIONS.has(action as string)) {
        throw new Error(
          `Expert "${String(expert.name)}" verdict "${verdict}" in ${where} has invalid ` +
            `action "${String(action)}" (valid: ${[...VALID_VERDICT_ACTIONS].join(', ')})`,
        )
      }
    }
  }

  /**
   * Find an entry in zip by name (case-insensitive, ignores leading ./).
   */
  private findEntry(entries: AdmZip.IZipEntry[], name: string): AdmZip.IZipEntry | undefined {
    const normalizedName = name.replace(/^\.\//, '').toLowerCase()

    return entries.find((entry) => {
      const entryName = entry.entryName.replace(/^\.\//, '').toLowerCase()
      return entryName === normalizedName || entryName === `./${normalizedName}`
    })
  }

  /**
   * Check if a file exists in the list (case-insensitive).
   */
  private fileExistsInZip(files: string[], name: string): boolean {
    const normalizedName = name.replace(/^\.\//, '').toLowerCase()
    return files.some((f) => {
      const normalized = f.replace(/^\.\//, '').toLowerCase()
      return normalized === normalizedName || normalized === `./${normalizedName}`
    })
  }
}
