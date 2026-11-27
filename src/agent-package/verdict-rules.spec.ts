import * as fs from 'fs'
import * as path from 'path'
import { validateConfigurationAgainstSchema } from '../agent-configurations/configuration-compat.util.js'
import { selectExpertDefaults } from './expert-defaults.js'
import { VERDICT_REACTIONS, VERDICT_RULE_FIELDS } from './manifest-defaults.js'
import { parseAgentManifest } from './schemas/agent-manifest.schema.js'
import {
  checkExpertListValue,
  checkExpertSafety,
  checkSafetyOff,
  checkVerdictRules,
  verdictRuleSupport,
} from './verdict-rules.js'

// #221: what a verdict leads to is configuration; the agent declares what it acts on.

const pipeline = (verdictRules?: Record<string, unknown>) => ({
  nodes: [
    {
      id: 'expert_pool',
      label: 'Experts',
      position: { row: 0, col: 0 },
      slots: [{ id: 'experts', label: 'Experts', type: 'expert_list' }],
    },
    {
      id: 'arbitration',
      label: 'Arbitration',
      position: { row: 0, col: 1 },
      slots: [],
      ...(verdictRules ? { verdict_rules: verdictRules } : {}),
    },
  ],
  edges: [],
  thresholds: [],
})

const supportsFollowup = verdictRuleSupport(pipeline({ reactions: ['ask_followup'], fields: ['flag', 'reaction'] }))

describe('verdict rule lists', () => {
  it('match the SDK, which the agents read', () => {
    const sdk = fs.readFileSync(
      path.join(process.cwd(), 'agents/stella-ai-agent-sdk/src/stella_agent_sdk/experts/verdict_rules.py'),
      'utf8',
    )
    const tuple = (name: string) =>
      [...(sdk.match(new RegExp(`^${name} = \\(([^)]*)\\)`, 'm'))?.[1] ?? '').matchAll(/"([a-z_]+)"/g)].map((m) => m[1])
    expect(tuple('REACTIONS')).toEqual([...VERDICT_REACTIONS])
    expect(tuple('RULE_FIELDS')).toEqual([...VERDICT_RULE_FIELDS])
  })
})

describe('checkVerdictRules', () => {
  it('passes the old fields on an agent that declares nothing', () => {
    expect(checkVerdictRules('medical', { high: { action: 'prepend', template: 'x' } }, verdictRuleSupport(pipeline()))).toEqual([])
  })

  it('refuses an unknown reaction', () => {
    const [problem] = checkVerdictRules('probing', { unclear: { reaction: 'sing' } }, supportsFollowup)
    expect(problem).toContain('unknown reaction "sing"')
  })

  it('refuses a reaction or field the agent did not declare', () => {
    const problems = checkVerdictRules(
      'probing',
      { unclear: { reaction: 'ask_back', min_confidence: 0.5 } },
      supportsFollowup,
    )
    expect(problems).toEqual([
      'expert "probing" verdict "unclear": this agent does not act on "min_confidence"',
      'expert "probing" verdict "unclear": this agent does not support the reaction "ask_back"',
    ])
  })

  it('a node that declares reactions acts on the reaction field without listing it', () => {
    const support = verdictRuleSupport(pipeline({ reactions: ['ask_followup'], fields: [] }))
    expect(checkVerdictRules('probing', { unclear: { reaction: 'ask_followup' } }, support)).toEqual([])
  })

  it('refuses bad values', () => {
    const all = verdictRuleSupport(pipeline({ reactions: [...VERDICT_REACTIONS], fields: [...VERDICT_RULE_FIELDS] }))
    const problems = checkVerdictRules(
      'x',
      { a: { min_confidence: 2, below: 'nowhere', flag: 'yes', must_avoid: 'one line', tone: 3 } },
      all,
    )
    expect(problems).toHaveLength(5)
  })
})

describe('the manifest declaration', () => {
  const manifest = (verdictRules: unknown) => ({
    version: '2.0',
    metadata: { name: 'A', slug: 'a-agent', version: '1.0.0', description: 'a' },
    image: { dockerfile: 'Dockerfile' },
    pipelineSchema: pipeline(verdictRules as Record<string, unknown>),
  })

  it('accepts a node that declares platform reactions and fields', () => {
    const result = parseAgentManifest(manifest({ reactions: ['ask_followup'], fields: ['reaction'] }))
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('refuses a reaction the platform does not have, and an unknown key', () => {
    expect(parseAgentManifest(manifest({ reactions: ['sing'], fields: [] })).valid).toBe(false)
    expect(parseAgentManifest(manifest({ reactions: [], fields: [], extra: 1 })).valid).toBe(false)
  })
})

describe('expert files', () => {
  const file = (expert: Record<string, unknown>) => ({ path: 'config/experts/x.json', content: JSON.stringify(expert) })

  it('refuses a rule the pipeline does not declare, so the upload fails instead of the session', () => {
    const expert = { name: 'probing', verdict_directives: { unclear: { action: 'inform', reaction: 'ask_back' } } }
    expect(() => selectExpertDefaults([file(expert)], ['experts'], pipeline({ reactions: ['ask_followup'], fields: ['reaction'] }))).toThrow(
      /does not support the reaction "ask_back"/,
    )
  })

  it('accepts one it does', () => {
    const expert = { name: 'probing', verdict_directives: { unclear: { action: 'inform', reaction: 'ask_followup' } } }
    expect(selectExpertDefaults([file(expert)], ['experts'], pipeline({ reactions: ['ask_followup'], fields: ['reaction'] }))).toHaveLength(1)
  })

  it('checks the safety declaration', () => {
    const directives = { none: {}, critical: {} }
    expect(checkExpertSafety({ name: 'medical', safety: true, never_step_down: ['critical'], verdict_directives: directives })).toEqual([])
    expect(checkExpertSafety({ name: 'medical', safety: 'yes' })).toHaveLength(1)
    expect(checkExpertSafety({ name: 'medical', safety: true, never_step_down: ['urgent'], verdict_directives: directives })).toHaveLength(1)
  })
})

describe('safety_off', () => {
  it('must be a confirmed record of who and when', () => {
    expect(checkSafetyOff('medical', undefined)).toBeNull()
    expect(checkSafetyOff('medical', { confirmed: true, by: 'a researcher', at: '2026-11-27T15:00:00Z' })).toBeNull()
    expect(checkSafetyOff('medical', { confirmed: false, by: 'a', at: '2026-11-27T15:00:00Z' })).toMatch(/confirmed/)
    expect(checkSafetyOff('medical', { confirmed: true, at: '2026-11-27T15:00:00Z' })).toMatch(/by/)
    expect(checkSafetyOff('medical', { confirmed: true, by: 'a', at: 'yesterday' })).toMatch(/at/)
    expect(checkSafetyOff('medical', true)).toMatch(/record/)
  })
})

describe('saved configurations', () => {
  const schema = pipeline({ reactions: ['ask_followup'], fields: ['flag', 'reaction'] })

  it('a configuration saved before #221 (old fields only) still validates', () => {
    const old = { nodes: { expert_pool: { experts: { medical: { enabled: true, verdict_directives: { high: { action: 'prepend', template: 'x' } } } } } } }
    expect(() => validateConfigurationAgainstSchema(old, schema)).not.toThrow()
  })

  it('refuses a verdict rule the agent does not act on', () => {
    const config = { nodes: { expert_pool: { experts: { probing: { verdict_directives: { unclear: { reaction: 'redirect' } } } } } } }
    expect(() => validateConfigurationAgainstSchema(config, schema)).toThrow(/does not support the reaction "redirect"/)
  })

  it('refuses safety_off without a proper record', () => {
    const config = { nodes: { expert_pool: { experts: { medical: { enabled: false, safety_off: { confirmed: true } } } } } }
    expect(() => validateConfigurationAgainstSchema(config, schema)).toThrow(/safety_off needs who/)
  })

  it('refuses safety, never_step_down and step_down_from, which belong to the expert file', () => {
    // A saved `safety: false` would otherwise switch the floor off without a safety_off record.
    const config = (entry: Record<string, unknown>) => ({ nodes: { expert_pool: { experts: { medical: entry } } } })
    expect(() => validateConfigurationAgainstSchema(config({ safety: false }), schema)).toThrow(
      /"safety" is set in the expert's file, not in a configuration/,
    )
    expect(() => validateConfigurationAgainstSchema(config({ never_step_down: [] }), schema)).toThrow(/"never_step_down"/)
    expect(() => validateConfigurationAgainstSchema(config({ step_down_from: 'choice' }), schema)).toThrow(/"step_down_from"/)
  })

  it('checks a standalone verdict_directives setting too', () => {
    const withSetting = pipeline({ reactions: ['ask_followup'], fields: ['reaction'] })
    ;(withSetting.nodes[1].slots as unknown[]).push({ id: 'verdicts', label: 'Verdicts', type: 'verdict_directives' })
    const config = { nodes: { arbitration: { verdicts: { unclear: { reaction: 'redirect' } } } } }
    expect(() => validateConfigurationAgainstSchema(config, withSetting)).toThrow(/does not support the reaction "redirect"/)
  })

  it('checkExpertListValue ignores entries that are not experts', () => {
    expect(checkExpertListValue({ x: 'junk' }, verdictRuleSupport(schema))).toEqual([])
  })
})
