import { RefreshCwIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { usePwaUpdate } from '@/pwa'

export function UpdateBanner() {
  const { needRefresh, reload, dismiss } = usePwaUpdate()
  const [mounted, setMounted] = useState(false)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (needRefresh) {
      setMounted(true)
      const frame = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(frame)
    }

    setVisible(false)
    const timer = window.setTimeout(() => setMounted(false), 150)
    return () => window.clearTimeout(timer)
  }, [needRefresh])

  if (!mounted) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'update-banner fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background px-4 py-3 shadow-[0_-8px_24px_rgba(0,0,0,0.08)]',
        visible ? 'is-visible' : 'is-hidden',
      )}
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">A new version is ready.</p>
          <p className="text-xs text-muted-foreground">Reload to get the latest console.</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
          Later
        </Button>
        <Button type="button" size="sm" onClick={reload}>
          <RefreshCwIcon />
          Reload
        </Button>
      </div>
    </div>
  )
}
