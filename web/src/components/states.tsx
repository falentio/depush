import { CircleAlertIcon, CloudOffIcon, RefreshCwIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { type ApiError, errorCopy } from '@/api/errors'
import { Brand } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export function BootSplash() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-background px-4">
      <Brand className="scale-110" />
      <div className="flex flex-col items-center gap-3">
        <p className="text-sm text-muted-foreground">Starting depush…</p>
        <div className="h-0.5 w-32 overflow-hidden rounded-full bg-muted">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
        </div>
      </div>
    </main>
  )
}

export function PageSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className="max-w-2xl space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="space-y-3 rounded-xl border border-border bg-card p-6">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="h-6 w-10" />
      </div>
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string
  description: string
  action?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-border bg-card px-6 py-14 text-center">
      <div className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </div>
      <h2 className="mt-4 text-base font-medium">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action === undefined ? null : <div className="mt-5">{action}</div>}
    </div>
  )
}

export function ErrorPanel({
  error,
  onRetry,
  children,
}: {
  error: ApiError
  onRetry?: () => void
  children?: ReactNode
}) {
  const copy = errorCopy(error)

  return (
    <div
      role="alert"
      className="mx-auto w-full max-w-lg rounded-xl border border-border bg-card p-6"
    >
      <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
        <CircleAlertIcon className="size-5" aria-hidden="true" />
      </div>
      <h2 className="mt-4 text-base font-semibold">{copy.title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
      {copy.action === 'reload' ? (
        <Button
          type="button"
          variant="outline"
          className="mt-5"
          onClick={() => window.location.reload()}
        >
          <RefreshCwIcon />
          Reload
        </Button>
      ) : null}
      {copy.action === 'retry' && onRetry !== undefined ? (
        <Button type="button" variant="outline" className="mt-5" onClick={onRetry}>
          <RefreshCwIcon />
          Try again
        </Button>
      ) : null}
      {children}
    </div>
  )
}

export function OfflineScreen({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const copy = errorCopy(error)
  const reload = copy.action === 'reload'

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4">
      <Brand className="scale-110" />
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
          <CloudOffIcon className="size-5" aria-hidden="true" />
        </div>
        <h1 className="mt-4 text-lg font-semibold">{copy.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{copy.description}</p>
        <Button
          type="button"
          className="mt-5"
          onClick={reload ? () => window.location.reload() : onRetry}
        >
          <RefreshCwIcon />
          {reload ? 'Reload' : 'Try again'}
        </Button>
      </div>
    </main>
  )
}
