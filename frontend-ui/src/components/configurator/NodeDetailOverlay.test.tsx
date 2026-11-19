import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import NodeDetailOverlay from './NodeDetailOverlay'
import type { PipelineNode } from '../../lib/api-types'

const pool = (slots: PipelineNode['slots']): PipelineNode => ({
  id: 'expert_pool',
  label: 'Expert Pool',
  position: { row: 0, col: 0 },
  slots,
})

const render = (node: PipelineNode, nodes: Record<string, Record<string, unknown>> = {}) =>
  renderToStaticMarkup(
    <NodeDetailOverlay
      node={node}
      configuration={{ nodes }}
      onUpdateNodeConfig={() => {}}
      onClose={() => {}}
      isDark={false}
      experts={[]}
    />,
  )

describe('NodeDetailOverlay — Expert Pool', () => {
  it("shows the pool's own settings under the experts, but not the expert lists", () => {
    const html = render(
      pool([
        { id: 'safety_threshold', label: 'Safety Threshold', type: 'number', default: 0.6, min: 0, max: 1, step: 0.05 },
        { id: 'expert_context', label: 'Expert Context', type: 'text', default: '', maxLength: 1000 },
        { id: 'experts', label: 'Experts List', type: 'expert_list' },
        { id: 'custom_experts', label: 'Custom Experts List', type: 'expert_list', isCustom: true },
      ]),
      { expert_pool: { expert_context: 'A weekly check-in chat.' } },
    )
    expect(html).toContain('Active Experts')
    expect(html).toContain('Pool Settings')
    expect(html).toContain('Safety Threshold')
    expect(html).toContain('Expert Context')
    expect(html).toContain('A weekly check-in chat.')
    expect(html).not.toContain('Experts List')
  })

  it('adds nothing when the pool has only its expert lists (V2)', () => {
    const html = render(pool([{ id: 'experts', label: 'Experts List', type: 'expert_list' }]))
    expect(html).toContain('Edit individual experts in the sidebar')
    expect(html).not.toContain('Experts List')
  })
})
