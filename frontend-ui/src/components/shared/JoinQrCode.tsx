import { useRef } from 'react'
import { QRCodeCanvas } from 'qrcode.react'
import { Ban, Download } from 'lucide-react'

interface JoinQrCodeProps {
  /** The join URL this QR encodes. Empty while there's nothing to show yet. Ignored once revoked. */
  value: string
  isDark: boolean
  /** Greys the QR out with a ban icon and disables the download, same as the link row next to it. Also stops the URL from being encoded at all. */
  revoked?: boolean
  /** The invitation's participant name, used to build the downloaded PNG's filename. May be blank. */
  participantName?: string | null
  size?: number
}

/** A revoked invitation's QR still renders (dimmed, with the ban icon), but never encodes the real link. */
const REVOKED_PLACEHOLDER = 'revoked'

function toSafeFilename(name: string | null | undefined): string {
  const slug = (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug ? `invite-${slug}.png` : 'invite-qr.png'
}

export default function JoinQrCode({ value, isDark, revoked = false, participantName, size = 176 }: JoinQrCodeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const encodedValue = revoked ? REVOKED_PLACEHOLDER : (value || ' ')

  const handleDownload = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    link.download = toSafeFilename(participantName)
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative">
        <div className={`p-3 rounded-xl inline-flex ${isDark ? 'bg-white' : 'bg-white border border-neutral-200/60'}`}>
          <QRCodeCanvas ref={canvasRef} value={encodedValue} size={size} level="M" />
        </div>
        {revoked && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/85">
            <Ban className="w-8 h-8 text-red-500" />
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={handleDownload}
        disabled={revoked}
        className={`
          inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-light
          transition-all duration-200
          ${revoked
            ? isDark
              ? 'bg-zinc-800/50 border border-zinc-700/50 text-zinc-600 cursor-not-allowed'
              : 'bg-neutral-100 border border-neutral-200 text-neutral-400 cursor-not-allowed'
            : isDark
              ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700'
              : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
          }
        `}
      >
        <Download className="w-3.5 h-3.5" />
        Download QR
      </button>
    </div>
  )
}
