import { describe, it, expect } from 'vitest'
import { mergeHistory, liveIdOf, correlationIdOf } from './chatHistory'

// Opening a chat loads the stored history on top of what the screen already
// collected live; nothing may show twice.
describe('mergeHistory', () => {
  const live = [
    { id: 'tr-1', role: 'assistant', text: 'Hello, thank you for taking part.' },
    { id: 'local-9', role: 'user', text: 'I was scared at first.', correlationId: 'c-1' },
    { id: 'local-10', role: 'user', text: 'Spoken answer' },
  ]

  it('drops stored copies of live messages: agent by transcript id, typed by correlation id, spoken by text', () => {
    const history = [
      { id: 'db-1', role: 'assistant', text: 'Hello, thank you for taking part.' },
      { id: 'tr-1', role: 'assistant', text: 'Hello, thank you for taking part.' },
      { id: 'db-2', role: 'user', text: 'I was scared at first.', correlationId: 'c-1' },
      { id: 'db-3', role: 'user', text: 'Spoken answer' },
    ]
    expect(mergeHistory(live, history)).toEqual(live)
  })

  it('keeps older messages the screen never saw, oldest first', () => {
    const history = [
      { id: 'db-0', role: 'assistant', text: 'Earlier question' },
      { id: 'tr-1', role: 'assistant', text: 'Hello, thank you for taking part.' },
    ]
    expect(mergeHistory(live, history).map(m => m.id)).toEqual(['db-0', 'tr-1', 'local-9', 'local-10'])
  })

  it('never merges join and leave events by their text', () => {
    const liveEvents = [{ id: 'e1', role: 'system', text: 'Tester joined', messageType: 'participant_event' }]
    const history = [{ id: 'db-e', role: 'system', text: 'Tester joined', messageType: 'participant_event' }]
    expect(mergeHistory(liveEvents, history)).toHaveLength(2)
  })
})

describe('reading ids from a stored envelope', () => {
  it('finds the transcript and correlation ids, or nothing', () => {
    expect(liveIdOf({ envelope: { type: 'agent_text', data: { transcript_id: 'tr-1' } } })).toBe('tr-1')
    expect(correlationIdOf({ envelope: { type: 'user_text', data: { text: 'hi', correlation_id: 'c-1' } } })).toBe('c-1')
    expect(liveIdOf({ envelope: { type: 'user_text', data: 'plain string' } })).toBeUndefined()
    expect(liveIdOf(null)).toBeUndefined()
  })
})
