import { WifiOffIcon } from 'lucide-react'
import { useOnline } from '@/lib/use-online'

export function OfflineBanner() {
  const online = useOnline()
  if (online) return null

  return (
    <div
      role="status"
      className="border-b border-amber-500/30 bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
    >
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2 text-xs sm:px-6 lg:px-8">
        <WifiOffIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span>You&apos;re offline. Changes are paused until the connection returns.</span>
      </div>
    </div>
  )
}
