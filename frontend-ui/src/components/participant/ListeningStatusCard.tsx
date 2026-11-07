/**
 * The participant's "Getting ready to listen…" card (#564): shown while speech
 * recognition warms up after a quiet spell, and if it fails to.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useSttPhase } from '../../hooks/useSttPhase'
import { PARTICIPANT_COPY, participantLanguage } from '../../lib/sttStatus'

export default function ListeningStatusCard() {
  const { status, phase } = useSttPhase()
  const copy = status && phase ? PARTICIPANT_COPY[participantLanguage(status)][phase] : null
  const failed = phase === 'failed'
  return (
    <AnimatePresence>
      {copy && (
        <motion.div
          key="listening-status"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.3 }}
          role="status"
          aria-live="polite"
          className="absolute bottom-16 inset-x-0 flex justify-center px-6 z-20 pointer-events-none"
        >
          <div className={`flex items-center gap-4 rounded-2xl px-6 py-4 backdrop-blur-md border max-w-lg ${
            failed ? 'bg-red-950/70 border-red-400/30' : 'bg-black/70 border-white/10'
          }`}>
            {failed
              ? <AlertTriangle className="w-7 h-7 text-red-300 shrink-0" />
              : <Loader2 className="w-7 h-7 text-violet-300 animate-spin shrink-0" />}
            <div>
              <div className="text-white text-xl font-medium">{copy.title}</div>
              <div className="text-white/70 text-base mt-0.5">{copy.body}</div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
