import {
  buildPodEnvVars,
  buildPodInjectionFromAgentTypeAndConfiguration,
  buildSecretStringData,
  deriveEffectiveAgentConfig,
  resolveAgentEnvVarsFromConfigSchema,
} from './agent-config-injection.util.js'

describe('agent-config-injection util', () => {
  const podEnvInput = {
    agentId: 'agent-123',
    sessionId: 'session-456',
    agentName: 'My Agent',
    agentIcon: '🤖',
    agentType: 'stella-v2-agent',
    grpcServerAddress: 'session-management-server:50051',
    sttServiceAddress: 'stt-service:50051',
    ttsServiceAddress: 'tts-service:50052',
    stateMachineAddress: 'session-management-server:50051',
    nodeEnv: 'local',
  }

  it('builds exact pod env vars in deterministic order', () => {
    // The order is intentional to match runtime injection and keep snapshot-style assertions stable.
    const envVars = buildPodEnvVars(podEnvInput)

    expect(envVars).toEqual([
      { name: 'AGENT_ID', value: 'agent-123' },
      { name: 'SESSION_ID', value: 'session-456' },
      { name: 'AGENT_NAME', value: 'My Agent' },
      { name: 'AGENT_ICON', value: '🤖' },
      { name: 'AGENT_TYPE', value: 'stella-v2-agent' },
      { name: 'GRPC_SERVER', value: 'session-management-server:50051' },
      { name: 'AGENT_IDENTITY', value: 'agent-agent-123' },
      { name: 'STT_SERVICE_ADDRESS', value: 'stt-service:50051' },
      { name: 'TTS_SERVICE_ADDRESS', value: 'tts-service:50052' },
      { name: 'STATE_MACHINE_ADDRESS', value: 'session-management-server:50051' },
      { name: 'NODE_ENV', value: 'local' },
    ])
  })

  it('derives effective config by deep-merging AgentType defaults with user configuration', () => {
    // User values override defaults; nested objects merge recursively.
    const agentConfig = deriveEffectiveAgentConfig(
      {
        slug: 'stella-v2-agent',
        defaultConfig: {
          llm: { model: 'gpt-4o-mini', temperature: 0.7 },
          flags: { safeMode: true },
        },
      },
      {
        configuration: {
          llm: { temperature: 0.2 },
          flags: { safeMode: false, expertMode: true },
        },
      },
    )

    expect(agentConfig).toEqual({
      llm: { model: 'gpt-4o-mini', temperature: 0.2 },
      flags: { safeMode: false, expertMode: true },
    })
  })

  it('builds exact secret payload including AGENT_CONFIG and custom env vars', () => {
    // Secret payload mirrors createSecret runtime behavior and must remain stable.
    const secret = buildSecretStringData({
      agentId: 'agent-123',
      livekitUrl: 'wss://livekit.local',
      livekitApiKey: 'lk-key',
      livekitApiSecret: 'lk-secret',
      roomName: 'room-a',
      ttsProvider: 'opensource',
      agentConfig: { llm: { model: 'gpt-4o-mini' }, plan: { states: [] } },
      customEnvVars: { OPENAI_API_KEY: 'sk-test', EXTRA: '1' },
    })

    expect(secret).toEqual({
      LIVEKIT_URL: 'wss://livekit.local',
      LIVEKIT_API_KEY: 'lk-key',
      LIVEKIT_API_SECRET: 'lk-secret',
      ROOM_NAME: 'room-a',
      IDENTITY: 'agent-agent-123',
      TTS_PROVIDER: 'opensource',
      AGENT_CONFIG: JSON.stringify({ llm: { model: 'gpt-4o-mini' }, plan: { states: [] } }),
      OPENAI_API_KEY: 'sk-test',
      EXTRA: '1',
    })
  })

  it('drops empty custom env vars so they fall through to the consumer default', () => {
    // Regression: an optional declared var carried into a template as "" must not
    // be injected — an empty value shadows the agent's built-in default and
    // crashed startup (float(os.getenv("BARGE_IN_EVAL_TIMEOUT_MS","2000")) on "").
    const secret = buildSecretStringData({
      agentId: 'agent-1',
      livekitUrl: 'wss://livekit.local',
      livekitApiKey: 'lk-key',
      livekitApiSecret: 'lk-secret',
      roomName: 'room-a',
      ttsProvider: 'opensource',
      agentConfig: {},
      customEnvVars: { OPENAI_API_KEY: 'sk-test', BARGE_IN_EVAL_TIMEOUT_MS: '', TTS_VOICE: '' },
    })

    expect(secret.OPENAI_API_KEY).toBe('sk-test')
    expect(secret).not.toHaveProperty('BARGE_IN_EVAL_TIMEOUT_MS')
    expect(secret).not.toHaveProperty('TTS_VOICE')
  })

  it('builds full injection payload from AgentType + user AgentConfiguration', () => {
    // End-to-end utility output: exact env vars and AGENT_CONFIG JSON for pod injection.
    // This is the closest deterministic unit test for what Kubernetes pod injection receives.
    const payload = buildPodInjectionFromAgentTypeAndConfiguration({
      agentType: {
        slug: 'stella-v2-agent',
        defaultConfig: {
          llm: { model: 'gpt-4o-mini', temperature: 0.7 },
          pipeline: { input_gate: { max_tokens: 60 } },
        },
        configSchema: {
          type: 'object',
          'x-stella-env-vars': ['OPENAI_API_KEY'],
          'x-stella-optional-env-vars': [
            { name: 'TTS_ENABLED', default: 'true' },
          ],
        },
      },
      userConfiguration: {
        configuration: {
          llm: { temperature: 0.1 },
          pipeline: { input_gate: { max_tokens: 120 } },
        },
      },
      podEnv: podEnvInput,
      secret: {
        agentId: 'agent-123',
        livekitUrl: 'wss://livekit.local',
        livekitApiKey: 'lk-key',
        livekitApiSecret: 'lk-secret',
        roomName: 'room-a',
        ttsProvider: 'opensource',
        customEnvVars: { OPENAI_API_KEY: 'sk-test' },
      },
    })

    expect(payload.envVars).toEqual(buildPodEnvVars(podEnvInput))
    expect(payload.agentConfig).toEqual({
      llm: { model: 'gpt-4o-mini', temperature: 0.1 },
      pipeline: { input_gate: { max_tokens: 120 } },
    })
    expect(payload.agentConfigJson).toBe(
      JSON.stringify({
        llm: { model: 'gpt-4o-mini', temperature: 0.1 },
        pipeline: { input_gate: { max_tokens: 120 } },
      }),
    )
    expect(payload.secretStringData.AGENT_CONFIG).toBe(payload.agentConfigJson)
    expect(payload.secretStringData.OPENAI_API_KEY).toBe('sk-test')
    // Optional env default should be injected because no explicit value was provided.
    expect(payload.secretStringData.TTS_ENABLED).toBe('true')
    expect(payload.appliedOptionalDefaults).toEqual(['TTS_ENABLED'])
    // Required env var is satisfied by provided OPENAI_API_KEY.
    expect(payload.missingRequiredEnvVars).toEqual([])
  })

  it('resolves required and optional env vars from configSchema', () => {
    // Required env vars are reported when missing; optional defaults are applied as fallback.
    const result = resolveAgentEnvVarsFromConfigSchema(
      {
        type: 'object',
        'x-stella-env-vars': ['OPENAI_API_KEY', 'ELEVENLABS_API_KEY'],
        'x-stella-optional-env-vars': [
          { name: 'TTS_ENABLED', default: 'true' },
          { name: 'TRANSCRIPT_DEBOUNCE_MS', default: '300' },
        ],
      },
      { OPENAI_API_KEY: 'sk-test', TTS_ENABLED: 'false' },
    )

    expect(result.resolvedEnvVars).toEqual({
      OPENAI_API_KEY: 'sk-test',
      TTS_ENABLED: 'false',
      TRANSCRIPT_DEBOUNCE_MS: '300',
    })
    expect(result.appliedOptionalDefaults).toEqual(['TRANSCRIPT_DEBOUNCE_MS'])
    expect(result.missingRequiredEnvVars).toEqual(['ELEVENLABS_API_KEY'])
  })
})
