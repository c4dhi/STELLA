/**
 * The message to show for a failed API call. ApiClient throws the server's
 * error body (a plain object, not an Error), whose `message` is a string, a
 * list of validation messages, or for a refused package a `{ message, errors }`.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message || fallback
  if (!err || typeof err !== 'object') return fallback
  const body = err as { message?: unknown; errors?: unknown }
  const errors = Array.isArray(body.errors) ? body.errors.filter((e): e is string => typeof e === 'string') : []
  const message = body.message
  if (typeof message === 'string' && message) return errors.length ? `${message}: ${errors.join('; ')}` : message
  if (Array.isArray(message)) {
    const parts = message.filter((m): m is string => typeof m === 'string')
    if (parts.length) return parts.join('; ')
  }
  if (message && typeof message === 'object') return apiErrorMessage(message, fallback)
  return fallback
}
