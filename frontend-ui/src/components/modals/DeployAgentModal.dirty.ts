export function isDeployAgentModalDirty(state: {
  step: string
  hasSelectedType: boolean
  name: string
}): boolean {
  return state.step !== 'gallery' || state.hasSelectedType || state.name.trim().length > 0
}
