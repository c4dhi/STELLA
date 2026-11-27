import { motion, AnimatePresence } from 'framer-motion'
import { DoorOpen } from 'lucide-react'

/** Shown to the participant when the conversation ends from the other side
 * (the organiser deletes the project or closes the session) rather than a
 * connection failure or the time cap. */
interface ConversationEndedOverlayProps {
  isVisible: boolean
}

export default function ConversationEndedOverlay({ isVisible }: ConversationEndedOverlayProps) {
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
              className="w-20 h-20 mx-auto mb-6 rounded-full bg-slate-500/20 flex items-center justify-center"
            >
              <DoorOpen className="w-10 h-10 text-slate-300" />
            </motion.div>

            <motion.h2
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.6, duration: 0.4 }}
              className="text-2xl font-light text-white mb-3"
            >
              Conversation ended
            </motion.h2>

            <motion.p
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.8, duration: 0.4 }}
              className="text-white/60 text-sm leading-relaxed"
            >
              This conversation has ended. You can close this window now.
            </motion.p>

          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
