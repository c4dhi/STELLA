import { describe, expect, it } from 'vitest'
import { ArgumentError, argumentsFromForm, resultText, toolParameters } from './connectorTools'

const tool = {
  name: 'get_next_question',
  inputSchema: {
    type: 'object',
    properties: {
      language: { type: 'string', enum: ['de', 'en'], default: 'de', description: 'Interview language' },
      participant_id: { type: 'string', description: 'Study id' },
      limit: { type: 'integer' },
      score: { type: ['number', 'null'] },
      dry_run: { type: 'boolean' },
      tags: { type: 'array' },
      extra: {},
    },
    required: ['participant_id'],
  },
}

describe('toolParameters', () => {
  it('reads types, enums, defaults and required fields, required first', () => {
    const params = toolParameters(tool)
    expect(params.map((p) => p.name)).toEqual(['participant_id', 'language', 'limit', 'score', 'dry_run', 'tags', 'extra'])
    expect(params[0]).toMatchObject({ type: 'string', required: true, description: 'Study id' })
    expect(params[1]).toMatchObject({ options: ['de', 'en'], defaultText: 'de', required: false })
    expect(params.find((p) => p.name === 'score')?.type).toBe('number')
    expect(params.find((p) => p.name === 'extra')?.type).toBe('unknown')
  })

  it('copes with a tool that has no schema', () => {
    expect(toolParameters({ name: 'ping' })).toEqual([])
  })
})

describe('argumentsFromForm', () => {
  const params = toolParameters(tool)

  it('turns text into typed arguments and leaves empty optional fields out', () => {
    expect(
      argumentsFromForm(params, { participant_id: ' P-1 ', limit: '3', dry_run: 'true', tags: '["a"]', extra: 'plain', language: '' }),
    ).toEqual({ participant_id: 'P-1', limit: 3, dry_run: true, tags: ['a'], extra: 'plain' })
  })

  it('names the field that is missing or does not parse', () => {
    expect(() => argumentsFromForm(params, {})).toThrow(ArgumentError)
    expect(() => argumentsFromForm(params, { participant_id: 'P', limit: '2.5' })).toThrow(/limit must be a whole number/)
    expect(() => argumentsFromForm(params, { participant_id: 'P', tags: '{"a":1}' })).toThrow(/tags must be a JSON array/)
  })
})

describe('resultText', () => {
  it('prefers structured content, then pretty-prints JSON text parts', () => {
    expect(resultText({ structuredContent: { a: 1 }, content: [] })).toBe('{\n  "a": 1\n}')
    expect(resultText({ content: [{ type: 'text', text: '{"b":2}' }, { type: 'text', text: 'done' }] })).toBe('{\n  "b": 2\n}\n\ndone')
    expect(resultText({ content: [] })).toBe('(no content)')
  })

  it('unwraps JSON a server sent as a string', () => {
    expect(resultText({ structuredContent: { result: '{"projects":[{"id":"p1"}]}' }, content: [] })).toBe(
      JSON.stringify({ result: { projects: [{ id: 'p1' }] } }, null, 2),
    )
    expect(resultText({ structuredContent: { note: 'not {json' }, content: [] })).toContain('"not {json"')
  })
})
