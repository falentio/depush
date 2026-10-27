import { Link, Outlet, useRouter } from '@tanstack/react-router'
import { LogOutIcon } from 'lucide-react'
import { useState } from 'react'
import { messageOf } from '@/api/errors'
import { paths } from '@/app/paths'
import { useAuth } from '@/auth/use-auth'
import { Brand } from '@/components/brand'
import { OfflineBanner } from '@/components/offline-banner'
import { ThemeToggle } from '@/components/theme-toggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const navLinkClass =
  'rounded-md px-3 py-1.5 text-sm text-muted-foreground outline-none transition-colors duration-150 ease-[var(--ease-out)] hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[status=active]:bg-accent data-[status=active]:text-foreground'

export function ConsoleLayout() {
  const auth = useAuth()
  const router = useRouter()
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const admin = auth.state === 'admin'

  async function signOut() {
    setSigningOut(true)
    setSignOutError(null)
    try {
      await router.options.context.authStore.signOut()
    } catch (error) {
      setSignOutError(messageOf(error))
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-border bg-background">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6 lg:px-8">
          <Brand />
          {admin ? (
            <nav
              aria-label="Console"
              className="order-3 flex w-full items-center gap-1 sm:order-none sm:w-auto"
            >
              <Link to={paths.apps} className={navLinkClass}>
                Apps
              </Link>
              <Link to={paths.settings} className={navLinkClass}>
                Settings
              </Link>
            </nav>
          ) : null}
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <Badge variant="secondary">{admin ? 'Admin' : 'User'}</Badge>
            <ThemeToggle />
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              aria-label="Sign out"
              title="Sign out"
              disabled={signingOut}
              onClick={() => {
                void signOut()
              }}
            >
              <LogOutIcon />
            </Button>
          </div>
        </div>
        {signOutError === null ? null : (
          <p
            role="alert"
            className="mx-auto max-w-6xl px-4 pb-2 text-xs text-destructive sm:px-6 lg:px-8"
          >
            {signOutError}
          </p>
        )}
      </header>
      <OfflineBanner />
      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <Outlet />
      </main>
    </>
  )
}
