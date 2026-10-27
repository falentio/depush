import { Outlet } from '@tanstack/react-router'
import { Brand } from '@/components/brand'
import { OfflineBanner } from '@/components/offline-banner'

export function AuthLayout() {
  return (
    <>
      <OfflineBanner />
      <main className="flex min-h-dvh flex-col items-center justify-center gap-7 bg-background px-4 py-12">
        <div className="flex flex-col items-center gap-1.5">
          <Brand className="scale-110" />
          <p className="text-xs text-muted-foreground">Self-hosted channels for your apps.</p>
        </div>
        <Outlet />
      </main>
    </>
  )
}
