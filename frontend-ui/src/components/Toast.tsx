import { motion, AnimatePresence } from 'framer-motion'
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useThemeStore } from '../store/themeStore'

export interface ToastProps {
  message: string
  type: 'success' | 'error' | 'info'
  onClose: () => void
  duration?: number
  link?: { to: string; label: string }
}

export default function Toast({ message, type, onClose, duration = 5000, link }: ToastProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  useEffect(() => {
    const timer = setTimeout(onClose, duration)
    return () => clearTimeout(timer)
  }, [duration, onClose])

  const colors = {
    success: isDark
      ? 'bg-green-900/90 border-green-700/60 text-green-200'
      : 'bg-green-50/95 border-green-200/60 text-green-800',
    error: isDark
      ? 'bg-red-900/90 border-red-700/60 text-red-200'
      : 'bg-red-50/95 border-red-200/60 text-red-800',
    info: isDark
      ? 'bg-blue-900/90 border-blue-700/60 text-blue-200'
      : 'bg-blue-50/95 border-blue-200/60 text-blue-800',
  }

  const icons = {
    success: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    ),
    error: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <path d="M15 9l-6 6M9 9l6 6" />
      </svg>
    ),
    info: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
    ),
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -20, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      className={`
        ${colors[type]}
        backdrop-blur-xl border
        rounded-xl shadow-[0_1px_30px_rgba(0,0,0,0.12)]
        px-4 py-3
        flex items-center gap-3
        min-w-[300px] max-w-md
      `}
    >
      <div className="flex-shrink-0">{icons[type]}</div>
      <div className="flex-1 text-sm font-light">
        {message}
        {link && (
          <Link to={link.to} onClick={onClose} className="block mt-0.5 underline underline-offset-2 opacity-90 hover:opacity-100">
            {link.label}
          </Link>
        )}
      </div>
      <button
        onClick={onClose}
        className="flex-shrink-0 text-current opacity-60 hover:opacity-100 transition-opacity"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </motion.div>
  )
}

interface ToastItem {
  id: string
  message: string
  type: 'success' | 'error' | 'info'
  duration?: number
  link?: { to: string; label: string }
}

interface ToastContainerProps {
  toasts: ToastItem[]
  onRemove: (id: string) => void
}

export function ToastContainer({ toasts, onRemove }: ToastContainerProps) {
  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2">
      <AnimatePresence>
        {toasts.map((toast) => (
          <Toast
            key={toast.id}
            message={toast.message}
            type={toast.type}
            onClose={() => onRemove(toast.id)}
            duration={toast.duration}
            link={toast.link}
          />
        ))}
      </AnimatePresence>
    </div>
  )
}
