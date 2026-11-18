import { useEffect, useState } from 'react'

export type ConnectionBanner = 'hidden' | 'offline' | 'back-online'

/** How long "Back online" stays up after the connection returns. */
export const BACK_ONLINE_MS = 3000

/** What the banner shows after the browser reports `online` or `offline`. */
export function nextBanner(current: ConnectionBanner, event: 'online' | 'offline'): ConnectionBanner {
  if (event === 'offline') return 'offline'
  // Only confirm a return we announced; a stray `online` while hidden stays hidden.
  return current === 'offline' ? 'back-online' : current
}

/** Tracks navigator.onLine and the window's online/offline events. */
export function useConnectionBanner(): ConnectionBanner {
  const [banner, setBanner] = useState<ConnectionBanner>(() =>
    typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'hidden',
  )

  useEffect(() => {
    const onOnline = () => setBanner(b => nextBanner(b, 'online'))
    const onOffline = () => setBanner(b => nextBanner(b, 'offline'))
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  useEffect(() => {
    if (banner !== 'back-online') return
    const t = setTimeout(() => setBanner(b => (b === 'back-online' ? 'hidden' : b)), BACK_ONLINE_MS)
    return () => clearTimeout(t)
  }, [banner])

  return banner
}
