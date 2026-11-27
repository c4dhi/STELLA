import { Check, Copy, ExternalLink } from 'lucide-react'
import JoinQrCode from './JoinQrCode'

interface PublicLinkDisplayProps {
  /** The public link this QR encodes and the field below it shows. */
  value: string
  isDark: boolean
  copied: boolean
  onCopy: () => void
  /** Spacing below the whole block, since each caller sits in a different layout. */
  marginBottomClassName?: string
}

/** A public project's link, with its QR code above it — #204, matching the participant connection screen. Shared by ProjectModal's "Public Project Created!" step and PublicLinkModal so both stay identical. */
export default function PublicLinkDisplay({
  value,
  isDark,
  copied,
  onCopy,
  marginBottomClassName = 'mb-4',
}: PublicLinkDisplayProps) {
  return (
    <div className={`flex flex-col items-center gap-3 ${marginBottomClassName}`}>
      <JoinQrCode value={value} isDark={isDark} size={112} />
      <div className={`
        flex-1 w-full flex items-center gap-2 coarse:gap-3 p-4 rounded-xl
        ${isDark ? 'bg-zinc-700/50 border border-zinc-600' : 'bg-neutral-50 border border-neutral-200'}
      `}>
        <input
          type="text"
          value={value}
          readOnly
          className={`flex-1 bg-transparent text-sm font-mono truncate ${isDark ? 'text-zinc-200' : 'text-neutral-700'}`}
        />
        <button
          onClick={onCopy}
          className={`
            p-2 rounded-lg transition-colors flex-shrink-0
            ${isDark
              ? 'hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200'
              : 'hover:bg-neutral-200 text-neutral-500 hover:text-neutral-700'
            }
          `}
          title="Copy link"
        >
          {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
        </button>
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className={`
            p-2 rounded-lg transition-colors flex-shrink-0
            ${isDark
              ? 'hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200'
              : 'hover:bg-neutral-200 text-neutral-500 hover:text-neutral-700'
            }
          `}
          title="Open in new tab"
        >
          <ExternalLink className="w-4 h-4" />
        </a>
      </div>
    </div>
  )
}
