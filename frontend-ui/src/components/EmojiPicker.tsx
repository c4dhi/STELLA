import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface EmojiPickerProps {
  value: string
  onChange: (emoji: string) => void
  /** The emojis offered. Defaults to a general set. */
  options?: string[]
}

const COMMON_EMOJIS = [
  '🤖', '🧠', '💡', '⚡', '🎯', '🚀', '💪', '🎨', '🔬', '📚',
  '🏥', '⚖️', '💰', '🎓', '🏆', '🌟', '🔥', '💻', '📊', '🎵',
  '🌈', '🦋', '🌺', '🍀', '🌙', '☀️', '⭐', '🌸', '🎭', '🎪'
]

export default function EmojiPicker({ value, onChange, options = COMMON_EMOJIS }: EmojiPickerProps) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="
          w-10 h-10 rounded-xl text-3xl
          bg-neutral-50/50 border border-neutral-200/60
          hover:border-neutral-400/60 hover:bg-white
          transition-all duration-200
          flex items-center justify-center
        "
      >
        {value}
      </button>

      <AnimatePresence>
        {isOpen && (
          <>
            {/* Backdrop */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => setIsOpen(false)}
            />

            {/* Emoji Grid */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: -10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -10 }}
              transition={{ duration: 0.15 }}
              className="
                absolute top-full left-0 mt-2 z-50
                bg-white/95 backdrop-blur-xl border border-neutral-200/60
                rounded-xl shadow-[0_1px_30px_rgba(0,0,0,0.12)]
                p-2 w-64 pr-4
              "
            >
              <div className="grid grid-cols-10 gap-1">
                {options.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => {
                      onChange(emoji)
                      setIsOpen(false)
                    }}
                    className="
                      w-8 h-8 text-lg rounded-lg
                      hover:bg-neutral-100
                      transition-colors duration-150
                      flex items-center justify-center
                    "
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}
