interface DiscardChangesDialogProps {
  open: boolean
  isDark: boolean
  onKeepEditing: () => void
  onDiscard: () => void
  title?: string
  message?: string
}

// Unsaved-changes confirmation (#177, #161) — matches the Agent Configurator / Plan Builder pattern.
export default function DiscardChangesDialog({
  open,
  isDark,
  onKeepEditing,
  onDiscard,
  title = 'Discard changes?',
  message = 'You have unsaved changes. If you close now, they will be lost.',
}: DiscardChangesDialogProps) {
  if (!open) return null

  return (
    <div
      className="absolute inset-0 z-[120] flex items-center justify-center bg-black/40"
      onClick={(e) => { e.stopPropagation(); onKeepEditing() }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`rounded-2xl p-6 max-w-sm w-full mx-4 shadow-xl ${
          isDark ? 'bg-zinc-900 border border-zinc-700' : 'bg-white border border-neutral-200'
        }`}
      >
        <h4 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-neutral-800'}`}>
          {title}
        </h4>
        <p className={`text-[13px] mt-1.5 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
          {message}
        </p>
        <div className="flex justify-end gap-2.5 mt-5">
          <button
            onClick={onKeepEditing}
            className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
              isDark ? 'text-zinc-300 hover:bg-zinc-800' : 'text-neutral-600 hover:bg-neutral-100'
            }`}
          >
            Keep editing
          </button>
          <button
            onClick={onDiscard}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-red-500 text-white hover:bg-red-600 transition-colors"
          >
            Discard changes
          </button>
        </div>
      </div>
    </div>
  )
}
