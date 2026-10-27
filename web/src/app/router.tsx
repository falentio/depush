import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type ErrorComponentProps,
  Link,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { toApiError } from '@/api/errors'
import { requireAccess } from '@/auth/guard'
import { landingFor } from '@/auth/policy'
import type { SettledAuth } from '@/auth/types'
import { AuthUnavailableError, isAuthUnavailableError } from '@/auth/types'
import { AuthLayout } from '@/components/layout/auth-layout'
import { ConsoleLayout } from '@/components/layout/console-layout'
import { RootLayout } from '@/components/layout/root-layout'
import { BootSplash, ErrorPanel, OfflineScreen, PageSkeleton } from '@/components/states'
import { Button } from '@/components/ui/button'
import { useOnline } from '@/lib/use-online'
import { AppsPage, AppsSkeleton } from '@/routes/apps'
import { ForbiddenPage } from '@/routes/forbidden'
import { NotFoundPage } from '@/routes/not-found'
import { SettingsPage } from '@/routes/settings'
import { SignInPage } from '@/routes/sign-in'
import { SignUpPage } from '@/routes/sign-up'
import type { RouterContext } from './context'
import { paths, signInSearchSchema } from './paths'

const rootRoute = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context }) => {
    const auth = await context.authStore.ensure()
    if (auth.state === 'unavailable') throw new AuthUnavailableError(auth.error)
    return { auth }
  },
  component: RootLayout,
  pendingComponent: BootSplash,
  pendingMs: 0,
  errorComponent: RootError,
  notFoundComponent: NotFoundPage,
})

const landingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: paths.landing,
  beforeLoad: ({ context }) => landingRedirect(context.auth),
})

const publicRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'public',
  component: AuthLayout,
})

const signInRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: paths.signIn,
  validateSearch: signInSearchSchema,
  beforeLoad: ({ context, location, search }) => {
    if (context.auth.state === 'admin') throw redirect({ to: search.redirect })
    requireAccess('anonymous-only')({ context, location })
  },
  component: SignInPage,
})

const signUpRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: paths.signUp,
  beforeLoad: requireAccess('anonymous-only'),
  component: SignUpPage,
})

const consoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'console',
  beforeLoad: requireAccess('authenticated'),
  component: ConsoleLayout,
})

const consoleIndexRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: paths.console,
  beforeLoad: ({ context }) => landingRedirect(context.auth),
})

const appsRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: paths.apps,
  beforeLoad: requireAccess('admin'),
  loader: ({ context }) => context.api.apps.list(),
  component: AppsPage,
  pendingComponent: AppsSkeleton,
  errorComponent: RouteError,
})

const settingsRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: paths.settings,
  beforeLoad: requireAccess('admin'),
  loader: ({ context }) => context.api.settings.read(),
  component: SettingsPage,
  pendingComponent: PageSkeleton,
  errorComponent: RouteError,
})

const forbiddenRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: paths.forbidden,
  beforeLoad: (args) => {
    requireAccess('authenticated')(args)
    if (args.context.auth.state === 'admin') throw redirect({ to: paths.apps })
  },
  component: ForbiddenPage,
})

const routeTree = rootRoute.addChildren([
  landingRoute,
  publicRoute.addChildren([signInRoute, signUpRoute]),
  consoleRoute.addChildren([consoleIndexRoute, appsRoute, settingsRoute, forbiddenRoute]),
])

export function createConsoleRouter(app: RouterContext) {
  return createRouter({ routeTree, context: app })
}

export type ConsoleRouter = ReturnType<typeof createConsoleRouter>

declare module '@tanstack/react-router' {
  interface Register {
    router: ConsoleRouter
  }
}

function landingRedirect(auth: SettledAuth): never {
  const to = landingFor(auth)
  if (to === paths.signIn) throw redirect({ to, search: { redirect: paths.apps } })
  throw redirect({ to })
}

function RootError({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  const online = useOnline()
  const wasOffline = useRef(!online)

  useEffect(() => {
    if (!online) {
      wasOffline.current = true
      return
    }
    if (!wasOffline.current) return
    wasOffline.current = false
    void router.options.context.authStore.refresh().then(() => router.invalidate())
  }, [online, router])

  if (isAuthUnavailableError(error)) {
    return (
      <OfflineScreen
        error={error.error}
        onRetry={() => {
          void router.options.context.authStore.refresh().then(() => router.invalidate())
        }}
      />
    )
  }

  return <ErrorPanel error={toApiError(error)} onRetry={() => reset()} />
}

function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  const apiError = toApiError(error)

  if (apiError.kind === 'http' && apiError.status === 403) {
    return (
      <ErrorPanel error={apiError}>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void router.options.context.authStore
                .refresh()
                .then(() => router.invalidate())
                .then(() => reset())
            }}
          >
            Refresh role
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              void router.options.context.authStore.signOut()
            }}
          >
            Sign out
          </Button>
        </div>
      </ErrorPanel>
    )
  }

  if (apiError.kind === 'http' && apiError.status === 401) {
    return (
      <ErrorPanel error={apiError}>
        <div className="mt-4">
          <Button asChild variant="outline">
            <Link to={paths.signIn} search={{ redirect: paths.apps }}>
              Sign in
            </Link>
          </Button>
        </div>
      </ErrorPanel>
    )
  }

  return <ErrorPanel error={apiError} onRetry={() => reset()} />
}
