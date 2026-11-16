import { describe, expect, it } from 'vitest'
import { isDeployAgentModalDirty } from './DeployAgentModal.dirty'

const pristine = { step: 'gallery', hasSelectedType: false, name: '' }

describe('isDeployAgentModalDirty', () => {
  it('is clean on the pristine gallery step', () => {
    expect(isDeployAgentModalDirty(pristine)).toBe(false)
  })

  it('is dirty once an agent type is selected', () => {
    expect(isDeployAgentModalDirty({ ...pristine, hasSelectedType: true })).toBe(true)
  })

  it('is dirty once a name is typed', () => {
    expect(isDeployAgentModalDirty({ ...pristine, name: 'Memory Coach' })).toBe(true)
  })

  it('is clean for a whitespace-only name', () => {
    expect(isDeployAgentModalDirty({ ...pristine, name: '   ' })).toBe(false)
  })

  it('is dirty once past the gallery step', () => {
    expect(isDeployAgentModalDirty({ ...pristine, step: 'configure' })).toBe(true)
  })

  it('is dirty mid-upload flow', () => {
    expect(isDeployAgentModalDirty({ step: 'envvars', hasSelectedType: true, name: 'Coach' })).toBe(true)
  })
})
