import { Outlet } from '@tanstack/react-router'

export function ConsoleLayout() {
  return (
    <div className="min-h-dvh bg-background">
      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <Outlet />
      </main>
    </div>
  )
}
