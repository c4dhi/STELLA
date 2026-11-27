/**
 * Which verdict rules an agent acts on (#221, #224): the union of what its
 * stages declare under `verdict_rules`. The Configurator offers only these, so a
 * saved configuration never carries a rule the agent would refuse. Declaring a
 * reaction implies the `reaction` field, as on the platform.
 */
import { createContext, useContext } from 'react'
import type { PipelineSchema } from '../../lib/api-types'

export interface VerdictRuleSupport {
  reactions: string[]
  fields: Set<string>
}

export const NO_VERDICT_RULES: VerdictRuleSupport = { reactions: [], fields: new Set() }

export function verdictRuleSupportOf(schema: Pick<PipelineSchema, 'nodes'> | null | undefined): VerdictRuleSupport {
  const reactions = new Set<string>()
  const fields = new Set<string>()
  for (const node of schema?.nodes ?? []) {
    for (const r of node.verdict_rules?.reactions ?? []) reactions.add(r)
    for (const f of node.verdict_rules?.fields ?? []) fields.add(f)
  }
  if (reactions.size > 0) fields.add('reaction')
  return { reactions: [...reactions], fields }
}

export const VerdictRuleSupportContext = createContext<VerdictRuleSupport>(NO_VERDICT_RULES)

export const useVerdictRuleSupport = () => useContext(VerdictRuleSupportContext)

/** A safety expert's switch-off record: who turned it off and when, confirmed. */
export interface SafetyOff {
  confirmed: true
  by: string
  at: string
}

export function readSafetyOff(raw: unknown): SafetyOff | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  return r.confirmed === true && typeof r.by === 'string' && typeof r.at === 'string'
    ? { confirmed: true, by: r.by, at: r.at }
    : undefined
}
