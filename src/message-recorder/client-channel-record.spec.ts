import { clientChannelRecord } from './message-recorder.service.js'

// Screen events, the agent's replies and its commands are kept in the session
// history: for a study, what the participant did and when is data.
describe('client channel records', () => {
  it('stores an event, a reply and a command as readable system lines with their data', () => {
    expect(clientChannelRecord({ type: 'client_event', data: { event: 'stella.interaction_mode', mode: 'text', request_id: 'r1' } }, 'p1')).toEqual({
      content: 'Screen event: stella.interaction_mode',
      messageType: 'client_event',
      role: 'system',
      status: 'final',
      metadata: { event: 'stella.interaction_mode', mode: 'text', request_id: 'r1', participant_id: 'p1' },
    })
    expect(clientChannelRecord({ type: 'client_event_reply', data: { event: 'rate', ok: false, error: 'too harsh' } }, 'agent-1')!.content).toBe(
      'Reply to rate: error: too harsh',
    )
    expect(clientChannelRecord({ type: 'agent_command', data: { command: 'sleep' } }, 'agent-1')!.content).toBe('Agent command: sleep')
  })

  it('ignores other envelopes and nameless ones', () => {
    expect(clientChannelRecord({ type: 'transcript', data: { event: 'x' } }, 'p')).toBeNull()
    expect(clientChannelRecord({ type: 'client_event', data: {} }, 'p')).toBeNull()
  })
})
