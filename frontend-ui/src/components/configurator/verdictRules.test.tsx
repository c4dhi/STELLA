// @vitest-environment jsdom
// #224: the configurator is drawn from what the agent declares, not from stage names.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import ExpertCard from './ExpertCard'
import NodeDetailOverlay from './NodeDetailOverlay'
import { VerdictRuleSupportContext, verdictRuleSupportOf } from './verdictRules'
import { findExpertPool, mergeVerdictDirectives, readVerdictDirectives, type ExpertDefinition } from './useConfiguratorState'
import { useAuthStore } from '../../store/authStore'
import type { PipelineNode } from '../../lib/api-types'

afterEach(cleanup)

const node = (id: string, extra: Partial<PipelineNode> = {}): PipelineNode => ({
  id, label: id, position: { row: 0, col: 0 }, slots: [], ...extra,
})

describe('what the agent declares', () => {
  it('finds the expert pool by its expert list, under any stage name', () => {
    const schema = {
      nodes: [
        node('gate'),
        node('panel', { slots: [
          { id: 'mine', label: 'Mine', type: 'expert_list', isCustom: true },
          { id: 'roster', label: 'Roster', type: 'expert_list' },
        ] }),
      ],
    }
    expect(findExpertPool(schema)).toEqual({ nodeId: 'panel', expertsKey: 'roster', customKey: 'mine' })
    expect(findExpertPool({ nodes: [node('gate')] })).toBeUndefined()
  })

  it("collects the verdict rules every stage acts on; a reaction implies the 'reaction' field", () => {
    const support = verdictRuleSupportOf({
      nodes: [
        node('a', { verdict_rules: { reactions: ['ask_back'], fields: ['min_confidence', 'below'] } }),
        node('b', { verdict_rules: { fields: ['flag'] } }),
        node('c'),
      ],
    })
    expect(support.reactions).toEqual(['ask_back'])
    expect([...support.fields].sort()).toEqual(['below', 'flag', 'min_confidence', 'reaction'])
    expect(verdictRuleSupportOf({ nodes: [node('c')] }).fields.size).toBe(0)
  })

  it('reads the rule fields of a verdict and merges a saved entry over the file field by field', () => {
    const file = readVerdictDirectives({
      doesnt_fit: { action: 'inform', template: '', reaction: 'ask_back', below: 'slight_doubt', min_confidence: 0.3 },
      fits: { action: 'inform', template: '' },
    })
    expect(file.doesnt_fit).toMatchObject({ reaction: 'ask_back', below: 'slight_doubt', min_confidence: 0.3 })
    // Saved before the rule fields existed: only the description changes.
    const merged = mergeVerdictDirectives(file, { doesnt_fit: { description: 'Odd for the question.' } })
    expect(merged.doesnt_fit).toMatchObject({ reaction: 'ask_back', below: 'slight_doubt', description: 'Odd for the question.' })
    expect(merged.fits).toEqual(file.fits)
  })
})

const expert = (over: Partial<ExpertDefinition> = {}): ExpertDefinition => ({
  name: 'medical', description: 'Health', enabled: true, alwaysTriggered: false, triggerCriteria: '',
  model: 'm', temperature: 0, maxTokens: 10, systemPrompt: undefined, defaultSystemPrompt: '', minConfidence: 0,
  arbitrationPriority: 50, isBackground: false, isCustom: false, canCallFunctions: false,
  verdictVocabulary: ['none', 'low', 'high', 'critical'],
  verdictDirectives: { high: { action: 'prepend', template: 'Careful.', below: 'low' } },
  defaultVerdictDirectives: { high: { action: 'prepend', template: 'Careful.', below: 'low' } },
  safety: true,
  ...over,
})

const card = (e: ExpertDefinition, onUpdate = vi.fn(), fields: string[] = [], reactions: string[] = []) => {
  render(
    <VerdictRuleSupportContext.Provider value={{ reactions, fields: new Set(fields) }}>
      <DndContext>
        <SortableContext items={[e.name]}>
          <ExpertCard expert={e} index={0} isExpanded onToggleExpand={() => {}} onUpdate={onUpdate} isDark={false} />
        </SortableContext>
      </DndContext>
    </VerdictRuleSupportContext.Provider>,
  )
  return onUpdate
}

describe('the expert panel', () => {
  it('turns a safety expert off only after a confirmation that records who and when', () => {
    useAuthStore.setState({ user: { email: 'researcher@example.org', name: 'R' } as never })
    const onUpdate = card(expert())
    expect(screen.getByText('safety')).toBeTruthy()
    fireEvent.click(screen.getByTitle('Disable expert'))
    expect(onUpdate).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    fireEvent.click(screen.getByText('Keep it on'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onUpdate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTitle('Disable expert'))
    fireEvent.click(screen.getByText('Turn it off'))
    const [update] = onUpdate.mock.calls[0]
    expect(update.safetyOff).toMatchObject({ confirmed: true, by: 'researcher@example.org' })
    expect(Number.isNaN(Date.parse(update.safetyOff.at))).toBe(false)
  })

  it('turns any other expert off at once', () => {
    const onUpdate = card(expert({ name: 'probing', safety: false }))
    expect(screen.queryByText('safety')).toBeNull()
    fireEvent.click(screen.getByTitle('Disable expert'))
    expect(onUpdate).toHaveBeenCalledWith({ enabled: false })
  })

  it("offers only the rule fields the agent declares, and saves a change", () => {
    const onUpdate = card(expert({ safety: false }), vi.fn(), ['below', 'min_confidence'])
    const rules = screen.getByTestId('verdict-rules-high')
    expect(rules.textContent).toContain('When not sure enough, becomes')
    expect(rules.textContent).toContain('How sure')
    expect(rules.textContent).not.toContain('Counts as a warning')
    expect(rules.textContent).not.toContain('What follows')
    fireEvent.change(rules.querySelector('select')!, { target: { value: 'none' } })
    expect(onUpdate.mock.calls[0][0].verdictDirectives.high.below).toBe('none')
  })

  it('shows no rule fields for an agent that declares none', () => {
    card(expert({ safety: false }))
    expect(screen.queryByTestId('verdict-rules-high')).toBeNull()
  })

  it('offers the reactions the agent carries out', () => {
    card(expert({ safety: false }), vi.fn(), ['reaction'], ['ask_back'])
    const select = screen.getByTestId('verdict-rules-high').querySelector('select')!
    expect([...select.options].map((o) => o.value)).toEqual(['', 'ask_back'])
  })
})

describe('a gate list setting', () => {
  it('is drawn as one row per gate', () => {
    const html = renderToStaticMarkup(
      <NodeDetailOverlay
        node={node('pool')}
        settings={[{
          key: 'pool.gates', type: 'gate_list', label: 'Gates',
          default: [{ skip: 'task_extraction', when: 'has_answer', verdicts: ['no'] }],
        }]}
        configuration={{ nodes: {} }}
        onUpdateNodeConfig={() => {}}
        onClose={() => {}}
        isDark={false}
        experts={[]}
      />,
    )
    expect(html).toContain('Gates')
    expect(html).toContain('value="task_extraction"')
    expect(html).toContain('value="has_answer"')
    expect(html).toContain('+ Add gate')
  })
})
