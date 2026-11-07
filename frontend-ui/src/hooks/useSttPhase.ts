import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { sttPhase, type SttPhase, type SttStatus } from '../lib/sttStatus'

/**
 * The speech-recognition status (#564) and its phase, re-checked every second
 * while warming so the screens switch to "taking longer than usual" on time.
 */
export function useSttPhase(): { status: SttStatus | null; phase: SttPhase | null; seconds: number } {
  const status = useStore((s) => s.sttStatus)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (status?.state !== 'warming') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [status])
  if (!status) return { status: null, phase: null, seconds: 0 }
  return { status, phase: sttPhase(status, now), seconds: Math.max(0, Math.round((now - status.since) / 1000)) }
}
