import { describe, expect, it } from 'vitest'
import { initialSettingValues, missingSettings, settingFields, settingsFromValues } from './settingsForm'

// The settings part of ELIAS-Interviewer's configSchema, as /agent-types returns it in requirements.
const schema = {
  type: 'object',
  properties: {
    elias: {
      type: 'object',
      required: ['project_id'],
      properties: {
        project_id: { type: 'string', description: 'ELIAS project id' },
        connector: { type: 'string', default: 'elias' },
        max_attempts: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
      },
    },
    llm: { type: 'object', properties: { model: { type: 'string', default: 'gpt-4o-mini' } } },
    tone: { type: 'string', enum: ['warm', 'neutral'] },
    verbose: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
  },
}
const defaults = { elias: { connector: 'elias', max_attempts: 3 } }

describe('settings form from configSchema', () => {
  it('lists required fields first and skips shapes it cannot edit', () => {
    const fields = settingFields(schema, defaults)
    expect(fields.map((f) => f.path)).toEqual([
      'elias.project_id',
      'elias.connector',
      'elias.max_attempts',
      'llm.model',
      'tone',
      'verbose',
    ])
    expect(fields[0]).toMatchObject({ required: true, kind: 'string', label: 'Elias › Project id' })
    expect(fields.find((f) => f.path === 'tone')).toMatchObject({ kind: 'enum', options: ['warm', 'neutral'] })
  })

  it('does not require a nested field whose parent nobody fills in', () => {
    const fields = settingFields(schema, {})
    expect(fields.find((f) => f.path === 'elias.project_id')?.required).toBe(false)
  })

  it('starts from the defaults and reports an empty required field', () => {
    const fields = settingFields(schema, defaults)
    const values = initialSettingValues(fields, schema, defaults)
    expect(values).toMatchObject({ 'elias.project_id': '', 'elias.max_attempts': '3', 'llm.model': 'gpt-4o-mini', verbose: false })
    expect(missingSettings(fields, values).map((f) => f.path)).toEqual(['elias.project_id'])
    expect(missingSettings(fields, { ...values, 'elias.project_id': ' 954c ' })).toEqual([])
  })

  it('builds the nested settings object with typed values and leaves blanks to the defaults', () => {
    const fields = settingFields(schema, defaults)
    const values = {
      ...initialSettingValues(fields, schema, defaults),
      'elias.project_id': ' 954c1a87 ',
      'elias.max_attempts': '2',
      'llm.model': '',
      tone: 'warm',
    }
    expect(settingsFromValues(fields, values)).toEqual({
      elias: { project_id: '954c1a87', connector: 'elias', max_attempts: 2 },
      tone: 'warm',
      verbose: false,
    })
  })

  it('has no fields without a schema', () => {
    expect(settingFields(null)).toEqual([])
  })
})
