/**
 * Verdict rules (#194, #221): what an expert's verdict leads to, as configuration.
 *
 * Every verdict in an expert's `verdict_directives` may carry rule fields
 * (VERDICT_RULE_FIELDS) next to its action, template and description. A
 * pipeline node declares which reactions it carries out and which fields it
 * reads (`verdict_rules: { reactions, fields }`). An expert file or a saved
 * configuration that uses anything no node declares is refused: undeclared is
 * refused, not ignored.
 *
 * The agent side of the same rules (merging, stepping down, the safety floor)
 * is the SDK's `stella_agent_sdk.experts.verdict_rules`; the lists are pinned
 * equal by verdict-rules.spec.ts.
 */
import { VERDICT_REACTIONS, VERDICT_RULE_FIELDS } from './manifest-defaults.js'

export interface VerdictRuleSupport {
  reactions: ReadonlySet<string>
  fields: ReadonlySet<string>
}

const REACTIONS = new Set<string>(VERDICT_REACTIONS)

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Every reaction and field any node of the pipeline declares it acts on. */
export function verdictRuleSupport(pipelineSchema: Record<string, unknown> | null | undefined): VerdictRuleSupport {
  const reactions = new Set<string>()
  const fields = new Set<string>()
  const nodes = (pipelineSchema?.nodes ?? []) as Array<Record<string, unknown>>
  for (const node of nodes) {
    const declared = node.verdict_rules
    if (!isPlainObject(declared)) continue
    for (const r of (declared.reactions as unknown[]) ?? []) if (typeof r === 'string') reactions.add(r)
    for (const f of (declared.fields as unknown[]) ?? []) if (typeof f === 'string') fields.add(f)
  }
  return { reactions, fields }
}

/** Why these verdict rules can't run on this agent, one line each; empty when they can. */
export function checkVerdictRules(expert: string, directives: unknown, support: VerdictRuleSupport): string[] {
  if (!isPlainObject(directives)) return []
  const problems: string[] = []
  const verdicts = new Set(Object.keys(directives))
  for (const [verdict, rule] of Object.entries(directives)) {
    if (!isPlainObject(rule)) continue
    const where = `expert "${expert}" verdict "${verdict}"`
    for (const field of VERDICT_RULE_FIELDS) {
      if (field in rule && !support.fields.has(field)) problems.push(`${where}: this agent does not act on "${field}"`)
    }
    const reaction = rule.reaction
    if (reaction !== undefined) {
      if (typeof reaction !== 'string' || !REACTIONS.has(reaction)) {
        problems.push(`${where}: unknown reaction "${String(reaction)}" (valid: ${VERDICT_REACTIONS.join(', ')})`)
      } else if (reaction !== 'none' && !support.reactions.has(reaction)) {
        problems.push(`${where}: this agent does not support the reaction "${reaction}"`)
      }
    }
    const confidence = rule.min_confidence
    if (confidence !== undefined && (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1))) {
      problems.push(`${where}: min_confidence must be a number from 0 to 1`)
    }
    const below = rule.below
    if (below !== undefined && (typeof below !== 'string' || !verdicts.has(below))) {
      problems.push(`${where}: below "${String(below)}" is not one of this expert's verdicts`)
    }
    if (rule.flag !== undefined && typeof rule.flag !== 'boolean') problems.push(`${where}: flag must be true or false`)
    for (const list of ['must_avoid', 'overrides'] as const) {
      const value = rule[list]
      if (value !== undefined && !(Array.isArray(value) && value.every((v) => typeof v === 'string'))) {
        problems.push(`${where}: ${list} must be a list of texts`)
      }
    }
    for (const text of ['tone', 'reaction_field'] as const) {
      if (rule[text] !== undefined && typeof rule[text] !== 'string') problems.push(`${where}: ${text} must be text`)
    }
  }
  return problems
}

/**
 * Why an expert file's safety declaration is malformed. `safety: true` makes
 * it a safety expert; `never_step_down` names the verdicts it never steps down
 * (the SDK defaults it to ["critical"]).
 */
export function checkExpertSafety(expert: Record<string, unknown>): string[] {
  const name = String(expert.name)
  const problems: string[] = []
  if (expert.safety !== undefined && typeof expert.safety !== 'boolean') {
    problems.push(`expert "${name}": safety must be true or false`)
  }
  const keep = expert.never_step_down
  if (keep !== undefined) {
    const verdicts = isPlainObject(expert.verdict_directives) ? new Set(Object.keys(expert.verdict_directives)) : new Set()
    if (!Array.isArray(keep) || !keep.every((v) => typeof v === 'string' && verdicts.has(v))) {
      problems.push(`expert "${name}": never_step_down must list some of its own verdicts`)
    }
  }
  return problems
}

/**
 * Why a saved configuration's `safety_off` for an expert is not a proper record.
 * Turning a safety expert off is its own confirmed step: `confirmed: true`, who
 * (`by`) and when (`at`, an ISO time). `enabled: false` alone never does it.
 */
export function checkSafetyOff(expert: string, value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (!isPlainObject(value)) return `expert "${expert}": safety_off must be a record`
  if (value.confirmed !== true) return `expert "${expert}": safety_off needs confirmed: true`
  if (typeof value.by !== 'string' || value.by.trim() === '') return `expert "${expert}": safety_off needs who turned it off (by)`
  if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) {
    return `expert "${expert}": safety_off needs when it was turned off (at)`
  }
  return null
}

/**
 * Every problem with the experts in an `expert_list` setting's value
 * (`{ name: { enabled, verdict_directives, safety_off, ... } }`).
 */
export function checkExpertListValue(value: unknown, support: VerdictRuleSupport): string[] {
  if (!isPlainObject(value)) return []
  const problems: string[] = []
  for (const [name, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) continue
    problems.push(...checkVerdictRules(name, entry.verdict_directives, support))
    const off = checkSafetyOff(name, entry.safety_off)
    if (off) problems.push(off)
  }
  return problems
}
