import { AnimatePresence, motion } from 'framer-motion'
import { Wifi, WifiOff } from 'lucide-react'
import { useConnectionBanner } from '../hooks/useConnectionBanner'

/**
 * A pill at the top centre of every screen while the device is offline, and
 * "Back online" for a moment after. It sits in the empty middle of the page
 * headers instead of pushing the page down, since several screens are exactly
 * one viewport tall. On a phone the headers have no empty middle, so it sits
 * just below them. It never takes clicks.
 */
export function OfflineBanner() {
  const banner = useConnectionBanner()
  const offline = banner === 'offline'

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[78px] sm:top-3 z-[9998] flex justify-center px-4 sm:px-16" aria-live="polite">
      <AnimatePresence>
        {banner !== 'hidden' && (
          <motion.div
            key={banner}
            role="status"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className={`flex items-center gap-2 rounded-full px-3.5 py-1.5 text-body-sm font-medium shadow-lg ${
              offline ? 'bg-amber-500 text-amber-950' : 'bg-emerald-600 text-white'
            }`}
          >
            {offline ? <WifiOff className="w-4 h-4 shrink-0" /> : <Wifi className="w-4 h-4 shrink-0" />}
            <span>
              {offline ? (
                <>
                  You're offline<span className="hidden sm:inline">: changes won't save until the connection is back</span>
                </>
              ) : (
                'Back online'
              )}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
