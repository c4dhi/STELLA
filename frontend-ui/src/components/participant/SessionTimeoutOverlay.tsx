import { motion, AnimatePresence } from 'framer-motion'
import { Clock } from 'lucide-react'

/** Shown to the participant when the session ends at its time limit. */
interface SessionTimeoutOverlayProps {
  isVisible: boolean
}

export default function SessionTimeoutOverlay({ isVisible }: SessionTimeoutOverlayProps) {
  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6 }}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-md"
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.2, duration: 0.5, ease: 'easeOut' }}
            className="text-center max-w-md mx-4"
          >
            <motion.div
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.4, duration: 0.4, type: 'spring', stiffness: 200 }}
              className="w-20 h-20 mx-auto mb-6 rounded-full bg-amber-500/20 flex items-center justify-center"
            >
              <Clock className="w-10 h-10 text-amber-400" />
            </motion.div>

            <motion.h2
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.6, duration: 0.4 }}
              className="text-2xl font-light text-white mb-3"
            >
              Session Timed Out
            </motion.h2>

            <motion.p
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.8, duration: 0.4 }}
              className="text-white/60 text-sm leading-relaxed"
            >
              Your session reached its time limit. Thank you for participating! You can close this window now.
            </motion.p>

          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
