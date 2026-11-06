import { withEnvDefaults } from '../../agents/deploy-request.js'
import type { AgentRequirements } from '../../agents/agent-requirements.js'

export interface InjectionAgentTypeInput {
  slug: string
  defaultConfig?: Record<string, unknown> | null
  /** The env vars the agent declares (requirements.env). */
  env?: AgentRequirements['env']
}

export interface InjectionAgentConfigurationInput {
  configuration?: Record<string, unknown> | null
}

export interface PodEnvBuildInput {
  agentId: string
  sessionId: string
  agentName: string
  agentIcon: string
  agentType: string
  grpcServerAddress: string
  sttServiceAddress: string
  ttsServiceAddress: string
  stateMachineAddress: string
  nodeEnv: string
}

export interface SecretDataBuildInput {
  agentId: string
  livekitUrl: string
  livekitApiKey: string
  livekitApiSecret: string
  roomName: string
  ttsProvider: string
  agentConfig: Record<string, unknown>
  customEnvVars?: Record<string, string>
}

export interface PodInjectionResult {
  // Exact env list injected directly in the container spec (non-secret values).
  envVars: Array<{ name: string; value: string }>
  // Exact secret stringData injected via envFrom (includes AGENT_CONFIG and API keys).
  secretStringData: Record<string, string>
  agentConfig: Record<string, unknown>
  agentConfigJson: string
  // Report-only output for validation/observability; callers can decide enforcement policy.
  missingRequiredEnvVars: string[]
  appliedOptionalDefaults: string[]
}


/**
 * Build the exact container env var list injected into the pod spec.
 * Keep order deterministic so tests can assert exact payloads.
 */
export function buildPodEnvVars(input: PodEnvBuildInput): Array<{ name: string; value: string }> {
  return [
    { name: 'AGENT_ID', value: input.agentId },
    { name: 'SESSION_ID', value: input.sessionId },
    { name: 'AGENT_NAME', value: input.agentName },
    { name: 'AGENT_ICON', value: input.agentIcon },
    { name: 'AGENT_TYPE', value: input.agentType },
    { name: 'GRPC_SERVER', value: input.grpcServerAddress },
    { name: 'AGENT_IDENTITY', value: `agent-${input.agentId}` },
    { name: 'STT_SERVICE_ADDRESS', value: input.sttServiceAddress },
    { name: 'TTS_SERVICE_ADDRESS', value: input.ttsServiceAddress },
    { name: 'STATE_MACHINE_ADDRESS', value: input.stateMachineAddress },
    { name: 'NODE_ENV', value: input.nodeEnv },
  ]
}

/**
 * Build the exact secret stringData map injected into the pod via envFrom.
 * Includes AGENT_CONFIG JSON plus merged custom environment variables.
 */
export function buildSecretStringData(input: SecretDataBuildInput): Record<string, string> {
  const agentConfigJson = JSON.stringify(input.agentConfig || {})

  return {
    LIVEKIT_URL: input.livekitUrl,
    LIVEKIT_API_KEY: input.livekitApiKey,
    LIVEKIT_API_SECRET: input.livekitApiSecret,
    ROOM_NAME: input.roomName,
    IDENTITY: `agent-${input.agentId}`,
    TTS_PROVIDER: input.ttsProvider,
    AGENT_CONFIG: agentConfigJson,
    ...filterNonEmptyEnvVars(input.customEnvVars),
  }
}

/**
 * Drop custom env vars whose value is empty so an empty variable always falls
 * through to the consumer's built-in default. An injected empty string would
 * otherwise SHADOW the default — e.g. `float(os.getenv("X", "2000"))` raises on
 * `""` — which is exactly what crashed agents when a template carried an unset
 * optional var. This is the universal backstop: whatever the source (template,
 * manual entry, an already-saved template with empty keys), an empty value never
 * reaches the pod. Fixed keys above are intentionally not filtered.
 */
function filterNonEmptyEnvVars(
  vars: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(vars || {})) {
    if (value !== undefined && value !== null && value !== '') {
      out[key] = value
    }
  }
  return out
}

/**
 * Derive effective agent config from AgentType defaults and user configuration.
 * User values override defaults with deep object merge semantics.
 */
export function deriveEffectiveAgentConfig(
  agentType: InjectionAgentTypeInput,
  userConfiguration: InjectionAgentConfigurationInput | null | undefined,
): Record<string, unknown> {
  const defaults = (agentType.defaultConfig || {}) as Record<string, unknown>
  const overrides = (userConfiguration?.configuration || {}) as Record<string, unknown>
  return deepMerge(defaults, overrides)
}

/**
 * Test-oriented helper that returns the exact env vars and AGENT_CONFIG payload
 * a pod would receive for a given AgentType + user AgentConfiguration combination.
 */
export function buildPodInjectionFromAgentTypeAndConfiguration(
  params: {
    agentType: InjectionAgentTypeInput
    userConfiguration?: InjectionAgentConfigurationInput | null
    podEnv: PodEnvBuildInput
    secret: Omit<SecretDataBuildInput, 'agentConfig'>
  },
): PodInjectionResult {
  const agentConfig = deriveEffectiveAgentConfig(params.agentType, params.userConfiguration)
  // Optional defaults the agent declares; provided env vars take precedence.
  const declared = params.agentType.env ?? { required: [], optional: [] }
  const { env: resolvedEnvVars, appliedDefaults } = withEnvDefaults(declared, params.secret.customEnvVars || {})
  const envVars = buildPodEnvVars(params.podEnv)
  const secretStringData = buildSecretStringData({
    ...params.secret,
    agentConfig,
    customEnvVars: resolvedEnvVars,
  })

  return {
    envVars,
    secretStringData,
    agentConfig,
    agentConfigJson: secretStringData.AGENT_CONFIG,
    missingRequiredEnvVars: declared.required.filter((name) => resolvedEnvVars[name] === undefined),
    appliedOptionalDefaults: appliedDefaults,
  }
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }

  for (const [key, value] of Object.entries(override)) {
    const existing = result[key]

    // Deep-merge plain objects; arrays and scalars are replaced by override value.
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value)
    } else {
      result[key] = value
    }
  }

  return result
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
