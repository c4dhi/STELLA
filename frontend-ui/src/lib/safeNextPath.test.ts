import { describe, expect, it } from 'vitest'
import { safeNextPath } from './safeNextPath'

describe('safeNextPath', () => {
  it('keeps paths inside the app, with their query', () => {
    expect(safeNextPath('/oauth/consent?request=abc')).toBe('/oauth/consent?request=abc')
    expect(safeNextPath('/settings/mcp')).toBe('/settings/mcp')
  })

  it('refuses anything that could leave the app', () => {
    for (const raw of ['https://evil.example', '//evil.example/x', '/\\evil.example', 'settings', '', null, undefined]) {
      expect(safeNextPath(raw)).toBeNull()
    }
  })
})
