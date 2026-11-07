import { STRUCTURAL_EXPERT_CAPABILITY, VERDICT_ACTIONS } from './manifest-defaults.js'

/** One config/experts/<name>.json file of an agent package. */
export interface ExpertFile {
  path: string
  content: string
}

const VALID_VERDICT_ACTIONS = new Set<string>(VERDICT_ACTIONS)
const EXPERT_FILE = /(^|\/)config\/experts\/[^/]+\.json$/i

export function isExpertFilePath(path: string): boolean {
  return EXPERT_FILE.test(path.replace(/^\.\//, ''))
}

/**
 * The default experts an agent publishes (AgentType.expertDefaults), read from its
 * config/experts/*.json files. Used for built-in agents (seed) and uploads alike.
 *
 * Each expert rides on a capability: the structural ones on the mode they
 * implement (task_extraction on "plans", companion_router on "companion"), every
 * other expert on "experts". An agent without that capability never publishes it.
 *
 * Throws on a broken file (invalid JSON, no name, duplicate name, unknown verdict
 * action) so a mistake fails the seed or the upload instead of reaching runtime,
 * where an unknown action would be silently coerced to "inform".
 */
export function selectExpertDefaults(
  files: ExpertFile[],
  capabilities: readonly string[],
): Record<string, unknown>[] | null {
  const caps = new Set(capabilities)
  const experts: Record<string, unknown>[] = []
  const seen = new Set<string>()

  // Sort by path for a deterministic, drift-free order.
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    let parsed: unknown
    try {
      parsed = JSON.parse(file.content)
    } catch (err) {
      throw new Error(`Invalid expert config ${file.path}: ${(err as Error).message}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const expert = parsed as Record<string, unknown>

    const name = expert.name
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(`Expert config ${file.path} is missing a "name" field`)
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate expert name "${name}" across config/experts/*.json (${file.path})`)
    }
    seen.add(name)
    assertVerdictActions(expert, file.path)

    if (caps.has(STRUCTURAL_EXPERT_CAPABILITY[name] ?? 'experts')) experts.push(expert)
  }

  return experts.length > 0 ? experts : null
}

function assertVerdictActions(expert: Record<string, unknown>, where: string): void {
  const directives = expert.verdict_directives
  if (!directives || typeof directives !== 'object') return
  for (const [verdict, directive] of Object.entries(directives as Record<string, unknown>)) {
    if (!directive || typeof directive !== 'object') continue
    const action = (directive as Record<string, unknown>).action
    if (action !== undefined && !VALID_VERDICT_ACTIONS.has(action as string)) {
      throw new Error(
        `Expert "${String(expert.name)}" verdict "${verdict}" in ${where} has invalid ` +
          `action "${String(action)}" (valid: ${VERDICT_ACTIONS.join(', ')})`,
      )
    }
  }
}
