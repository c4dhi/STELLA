/**
 * Where to go after signing in, from a `?next=` value. Only paths inside this
 * app are accepted, so a crafted link cannot bounce a fresh login to another
 * site (open redirect).
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null
  return raw
}
