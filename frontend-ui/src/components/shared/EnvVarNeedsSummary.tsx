/**
 * One quiet line saying which env vars an agent needs and which it can use,
 * in place of stacked banners. What each one does is shown on its row.
 */
interface EnvVarNeedsSummaryProps {
  required: string[]
  optional: string[]
  isDark: boolean
}

export default function EnvVarNeedsSummary({ required, optional, isDark }: EnvVarNeedsSummaryProps) {
  if (required.length === 0 && optional.length === 0) return null
  const key = `font-mono ${isDark ? 'text-zinc-200' : 'text-neutral-800'}`
  const list = (keys: string[]) =>
    keys.map((k, i) => (
      <span key={k}>
        {i > 0 && ', '}
        <span className={key}>{k}</span>
      </span>
    ))
  return (
    <p className={`text-sm font-light mb-4 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
      {required.length > 0 && <>Needs {list(required)}. </>}
      {optional.length > 0 && <>Can also use {list(optional)}.</>}
    </p>
  )
}
