/**
 * The screen's side of the client channel (see the SDK's client_channel.py).
 *
 * - send(event, data): tell the agent something, no answer expected.
 * - request(event, data): the same, with a request_id; resolves with the first
 *   agent's reply (ok or not) and rejects when none comes in time.
 *
 * The agent refuses events its agent.yaml does not declare. `stella.…` events
 * are the platform's own and every agent handles them.
 */

export const INTERACTION_MODE_EVENT = 'stella.interaction_mode'
export type InteractionMode = 'voice' | 'text'

export interface ClientEventReply {
  request_id: string
  event: string
  ok: boolean
  data?: Record<string, unknown>
  error?: string
  agent_id?: string | null
}

export interface ClientEventEnvelope {
  type: 'client_event'
  data: { event: string; request_id?: string; timestamp: number; [key: string]: unknown }
}

export interface ClientChannel {
  send: (event: string, data?: Record<string, unknown>) => void
  request: (event: string, data?: Record<string, unknown>, timeoutMs?: number) => Promise<ClientEventReply>
  /** Feed every incoming data envelope; true when it was a reply this channel consumed. */
  handleEnvelope: (envelope: unknown) => boolean
  /** Reject every request still waiting (e.g. on disconnect). */
  close: () => void
}

const ENVELOPE_KEYS = new Set(['event', 'request_id', 'timestamp'])

export function createClientChannel(
  publish: (envelope: ClientEventEnvelope) => void,
  newId: () => string = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`),
): ClientChannel {
  const pending = new Map<string, { resolve: (r: ClientEventReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  const envelope = (event: string, data: Record<string, unknown>, requestId?: string): ClientEventEnvelope => {
    const own = Object.fromEntries(Object.entries(data).filter(([k]) => !ENVELOPE_KEYS.has(k)))
    return { type: 'client_event', data: { ...own, event, timestamp: Date.now(), ...(requestId ? { request_id: requestId } : {}) } }
  }

  return {
    send(event, data = {}) {
      publish(envelope(event, data))
    },
    request(event, data = {}, timeoutMs = 4000) {
      const id = newId()
      return new Promise<ClientEventReply>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`no reply to ${event} within ${timeoutMs} ms`))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        try {
          publish(envelope(event, data, id))
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    handleEnvelope(raw) {
      const env = raw as { type?: string; data?: Partial<ClientEventReply> } | null
      if (!env || env.type !== 'client_event_reply') return false
      const id = env.data?.request_id
      const waiting = id ? pending.get(id) : undefined
      if (waiting) {
        clearTimeout(waiting.timer)
        pending.delete(id!)
        waiting.resolve(env.data as ClientEventReply)
      }
      return true // a reply to another screen, or a second agent's reply: ours to drop
    },
    close() {
      for (const [id, waiting] of pending) {
        clearTimeout(waiting.timer)
        waiting.reject(new Error('client channel closed'))
        pending.delete(id)
      }
    },
  }
}

/**
 * Tell the agents which interface the participant uses, retrying a few times
 * when no agent answers (one may still be starting). Resolves with whether an
 * agent confirmed it.
 */
export async function announceInteractionMode(
  channel: ClientChannel,
  mode: InteractionMode,
  { attempts = 3, timeoutMs = 3000 }: { attempts?: number; timeoutMs?: number } = {},
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const reply = await channel.request(INTERACTION_MODE_EVENT, { mode }, timeoutMs)
      return reply.ok
    } catch {
      // no agent answered in time: try again
    }
  }
  return false
}
