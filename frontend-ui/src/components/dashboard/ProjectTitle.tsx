import { Pencil } from 'lucide-react'

interface Props {
  name: string
  isDark: boolean
  /** Shows the pencil. */
  canEdit: boolean
  /** Opens the edit-project window. */
  onEdit: () => void
}

/** The project name on its sessions screen, with a pencil that opens the edit-project window. */
export function ProjectTitle({ name, isDark, canEdit, onEdit }: Props) {
  return (
    <div className="flex items-center gap-1.5">
      <h1 className={`text-heading-sm font-semibold tracking-tight ${
        isDark ? 'text-content-inverse' : 'text-content'
      }`}>
        {name}
      </h1>
      {canEdit && (
        <button
          type="button"
          onClick={onEdit}
          className={`p-1 rounded-md transition-colors ${
            isDark
              ? 'text-content-inverse-tertiary hover:text-content-inverse hover:bg-surface-dark-tertiary'
              : 'text-content-tertiary hover:text-content hover:bg-surface-secondary'
          }`}
          title="Edit project"
          aria-label="Edit project"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}
