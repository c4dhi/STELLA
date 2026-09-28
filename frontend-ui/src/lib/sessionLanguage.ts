/**
 * Who decides the session language, and what the deploy UI does about it.
 *
 * There are two places a language can come from, and they are not equal:
 *
 *   - The PLAN declares it. A plan whose prompts and acceptance criteria are
 *     written in German is German wherever it is deployed. This is a property
 *     of the content, so the plan owns it.
 *   - The OPERATOR pins it at deploy time (STELLA_LANGUAGE). This exists for
 *     plans that declare nothing — without it, a short or garbled first
 *     utterance decides the language of the whole conversation by coin flip.
 *
 * The plan wins. STELLA_LANGUAGE outranks the plan's pin in the agent, so
 * writing both would let a stale picker value silently contradict the plan —
 * which is precisely the bug this shape prevents.
 *
 * Both deploy modals (DeployAgentModal, ProjectModal) share these rules; they
 * live here so the two cannot drift apart.
 */
import type { PlanTemplate, TtsCapabilities } from './api-types'

/** The language the selected plan declares, normalized. '' = declares none. */
export function planDeclaredLanguage(plan: PlanTemplate | null | undefined): string {
  return (plan?.content?.language || '').trim().toLowerCase()
}

/**
 * Whether the Voice & Language step has anything left to ask.
 *
 * A provider with no selectable voices offers only the language picker — so if
 * the plan has already settled that, the step is empty and is skipped rather
 * than shown as a read-only page the operator has to click past.
 */
export function showsVoiceStep(
  capabilities: TtsCapabilities | null,
  planLanguage: string,
): boolean {
  if (!capabilities || capabilities.voices.length === 0) return false
  if (capabilities.supportsVoiceSelection) return true
  return capabilities.languages.length > 0 && !planLanguage
}

/**
 * The language env vars to deploy with.
 *
 * Empty when the plan declares a language: the agent applies the plan's pin at
 * session start, before the first utterance, so nothing needs pinning here —
 * and pinning anyway would override the plan.
 */
export function languageEnvVars(
  pickedLanguage: string,
  planLanguage: string,
): Record<string, string> {
  if (planLanguage || !pickedLanguage) return {}
  // STELLA_LANGUAGE pins the conversation: STT transcribes as this language,
  // the resolver forces every turn to it, and the reply is written in it.
  // TTS_LANGUAGE goes along so the very first synthesis — which happens before
  // any turn has resolved — already uses the right reference clip.
  return { STELLA_LANGUAGE: pickedLanguage, TTS_LANGUAGE: pickedLanguage }
}
