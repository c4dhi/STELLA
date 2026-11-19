import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import NodeDetailOverlay from './NodeDetailOverlay'
import type { ConfigSetting, PipelineNode } from '../../lib/api-types'

// #996: a stage's popup is drawn from the settings the agent declares for it,
// whatever the agent or the stage; the control follows the setting's type.

const node = (id: string): PipelineNode => ({ id, label: id, position: { row: 0, col: 0 }, slots: [] })

const render = (id: string, settings: ConfigSetting[], values: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <NodeDetailOverlay
      node={node(id)}
      settings={settings}
      configuration={{ nodes: { [id]: values } }}
      onUpdateNodeConfig={() => {}}
      onClose={() => {}}
      isDark={false}
      experts={[]}
    />,
  )

describe('NodeDetailOverlay', () => {
  it("draws a stage's settings by type: experts, text, then fields in their groups", () => {
    const html = render(
      'expert_pool',
      [
        { key: 'expert_pool.experts', type: 'expert_list', label: 'Experts List' },
        { key: 'expert_pool.expert_context', type: 'text', label: 'Expert Context', maxLength: 1000 },
        { key: 'expert_pool.safety_threshold', type: 'number', label: 'Safety Threshold', default: 0.6, min: 0, max: 1 },
        { key: 'expert_pool.jev_timeout_ms', type: 'integer', label: 'Jev Timeout', unit: 'ms', group: 'Timing' },
      ],
      { expert_context: 'A weekly check-in chat.' },
    )
    expect(html).toContain('Active Experts')
    expect(html).toContain('Expert Context')
    expect(html).toContain('A weekly check-in chat.')
    expect(html).toContain('Safety Threshold')
    expect(html).toContain('Jev Timeout (ms)')
    expect(html).toContain('Timing')
    expect(html).not.toContain('Experts List')
  })

  it('draws any stage the same way, with choices and switches from the declaration', () => {
    const html = render('response_generator', [
      { key: 'response_generator.model', type: 'enum', label: 'Model', default: 'm-1', options: [{ value: 'm-1' }, { value: 'm-2' }] },
      { key: 'response_generator.stream', type: 'boolean', label: 'Stream', default: true },
    ])
    expect(html).toContain('Default (m-1)')
    expect(html).toContain('<option value="m-2">m-2</option>')
    expect(html).toContain('Default (true)')
    expect(html).not.toContain('No configuration available')
  })

  it('edits pairs and lists, and says so when a stage declares nothing', () => {
    const pairs = render('arbitration', [{ key: 'arbitration.tone_map', type: 'key_value', label: 'Tone Map', default: { medical: 'calm' } }])
    expect(pairs).toContain('value="medical"')
    expect(pairs).toContain('>calm</textarea>')
    expect(pairs).toContain('+ Add')
    const list = render('companion', [{ key: 'companion.topics', type: 'string_list', label: 'Topics', default: ['garden'] }], { topics: ['books', 'walks'] })
    expect(list).toContain('>books\nwalks</textarea>')
    expect(list).toContain('Reset to default')
    expect(render('companion', [])).toContain('No configuration available')
  })
})
