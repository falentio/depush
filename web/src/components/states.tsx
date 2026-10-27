import type { ReactNode } from 'react'
import type { ApiError } from '@/api/errors'
import { errorCopy } from '@/api/errors'

export function BootSplash() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background">
      <p className="text-sm text-muted-foreground">Starting depush…</p>
    </main>
  )
}

export function PageSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className="space-y-4">
      <div className="h-8 w-40 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      <div className="h-24 rounded-xl bg-muted" />
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-8 text-center">
      <h2 className="text-base font-medium">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      {action === undefined ? null : <div className="mt-4">{action}</div>}
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
    <div role="alert" className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-base font-medium">{copy.title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
      {onRetry === undefined ? null : (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-md border border-border px-3 py-2 text-sm active:scale-[0.97]"
        >
          Try again
        </button>
      )}
      {children}
    </div>
  )
}

export function OfflineScreen({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-lg font-semibold">{errorCopy(error).title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{errorCopy(error).description}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground active:scale-[0.97]"
        >
          Try again
        </button>
      </div>
    </main>
  )
}
