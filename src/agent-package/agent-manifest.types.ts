/**
 * Type definitions for agent.yaml manifest file
 */

import type { EnvVarSetting } from './env-var-settings.js'

/** A declared variable; the typed fields are described on `EnvVarSetting`. */
export type AgentOptionalEnvVar = EnvVarSetting

export interface ConfigSchemaExtensions {
  'x-stella-env-vars'?: string[]
  'x-stella-optional-env-vars'?: AgentOptionalEnvVar[]
  'x-stella-supports-configurator'?: boolean
  'x-stella-requires-plan'?: boolean
}

export interface AgentManifest {
  version: string  // Schema version (e.g., "1.0")

  metadata: {
    name: string            // Display name
    slug: string            // URL-safe identifier (lowercase, hyphens)
    version: string         // Semantic version (e.g., "1.0.0")
    description: string     // Short description
    author?: {
      name: string
      email?: string
    }
    icon?: string           // Emoji or image URL
    tags?: string[]         // For filtering
  }

  capabilities?: string[]   // e.g., ["voice", "text", "progress"]

  image: {
    dockerfile?: string     // Path to Dockerfile in package (default: "Dockerfile")
    imageUrl?: string       // Pre-built image URL (alternative to dockerfile)
  }

  resources?: {
    memory?: {
      request?: string      // e.g., "512Mi"
      limit?: string        // e.g., "2Gi"
    }
    cpu?: {
      request?: string      // e.g., "250m"
      limit?: string        // e.g., "1000m"
    }
    gpu?: boolean           // Whether GPU is required
  }

  // JSON Schema for config options
  configSchema?: Record<string, unknown> & ConfigSchemaExtensions

  // Default config values
  defaultConfig?: Record<string, unknown>

  // Pipeline schema (topology + configurable slots for Agent Configurator)
  pipelineSchema?: Record<string, unknown>

  // Per-AgentType {{placeholder}} palette for the Configurator (manifest-driven).
  runtimeVariables?: Record<string, unknown>[]

  // Version of the SDK prompt compiler this agent resolves prompts with. Saved
  // configurations can require a minimum version, so this must be persisted.
  promptCompiler?: {
    version?: string
  }

  sdk?: {
    minVersion?: string     // Minimum stella-ai-agent-sdk version
  }
}

export interface ManifestValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  manifest?: AgentManifest
}

export interface PackageValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  manifest?: AgentManifest
  files: string[]
}

// Validation constants
export const MANIFEST_SCHEMA_VERSION = '1.0'
export const SUPPORTED_BASE_IMAGES = [
  'python:3.10-slim',
  'python:3.11-slim',
  'python:3.12-slim',
  'python:3.10',
  'python:3.11',
  'python:3.12',
]

export const RESOURCE_LIMITS = {
  memory: {
    max: '4Gi',
    default: '512Mi',
  },
  cpu: {
    max: '2000m',
    default: '250m',
  },
}

export const SLUG_REGEX = /^[a-z][a-z0-9-]*[a-z0-9]$/
export const VERSION_REGEX = /^\d+\.\d+\.\d+$/
