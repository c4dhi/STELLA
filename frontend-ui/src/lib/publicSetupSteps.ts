import { asksForMode } from './deployNeeds'
import type { AgentMode, DeployNeeds } from './deployNeeds'

export type PublicAgentStep = 'agent' | 'configure' | 'configuration' | 'mode' | 'persona' | 'plan' | 'activities' | 'connectors' | 'voice'

/**
 * The agent steps of the public-project setup, before its settings and link
 * steps. Every mode the agent declares is offered, as in the deploy dialog
 * (#207): a companion picks a menu of activities instead of one plan.
 */
export function publicSetupSteps(
  needs: DeployNeeds,
  runMode: AgentMode,
  shown: { configurator: boolean; voice: boolean },
): PublicAgentStep[] {
  const s: PublicAgentStep[] = ['agent', 'configure']
  if (needs.configurator && shown.configurator) s.push('configuration')
  // Mode first: it decides the preselected persona and whether one plan or a
  // menu of activities is picked afterwards.
  if (asksForMode(needs)) s.push('mode')
  // Persona before plan: a public visitor never picks it, so whatever is set
  // here is what every session on this link runs with.
  if (needs.persona) s.push('persona')
  // Plan before voice: the plan may declare the language, and the voice step
  // needs to know that to skip the picker.
  if (needs.modes.length > 0) s.push(runMode === 'companion' ? 'activities' : 'plan')
  // Always shown, even with none yet: it's how someone with no connectors
  // finds out they exist (#891).
  s.push('connectors')
  if (shown.voice) s.push('voice')
  return s
}
