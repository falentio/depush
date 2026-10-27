import * as v from 'valibot'

export type ConsolePath = '/' | `/console${string}`

export const paths = {
  landing: '/',
  signIn: '/console/sign-in',
  signUp: '/console/sign-up',
  console: '/console',
  apps: '/console/apps',
  settings: '/console/settings',
  forbidden: '/console/forbidden',
} as const satisfies Record<string, ConsolePath>

export type KnownPath = (typeof paths)[keyof typeof paths]

/**
 * TanStack route ids include the pathless layout group's id, while the URL path
 * does not. Pages read their loader data by id, so the ids live next to the
 * paths they pair with.
 */
export const routeIds = {
  landing: '/',
  public: `/public`,
  signIn: `/public${paths.signIn}`,
  signUp: `/public${paths.signUp}`,
  console: '/console',
  consoleIndex: `/console${paths.console}`,
  apps: `/console${paths.apps}`,
  settings: `/console${paths.settings}`,
  forbidden: `/console${paths.forbidden}`,
} as const

export const WORKER_ROUTES = {
  api: '/api',
  apps: '/apps',
  app: '/app',
  healthz: '/healthz',
} as const

export const WORKER_PREFIXES = [
  WORKER_ROUTES.api,
  WORKER_ROUTES.apps,
  WORKER_ROUTES.app,
  WORKER_ROUTES.healthz,
] as const

export const signInSearchSchema = v.object({
  redirect: v.fallback(v.picklist([paths.apps, paths.settings]), paths.apps),
})

export type SignInSearch = v.InferOutput<typeof signInSearchSchema>

export function guardedPath(pathname: string): typeof paths.apps | typeof paths.settings {
  return pathname === paths.settings ? paths.settings : paths.apps
}

export function isWorkerPath(pathname: string): boolean {
  return WORKER_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

export function assertRouteNamespace(clientPaths: readonly string[]): void {
  for (const path of clientPaths) {
    if (isWorkerPath(path)) {
      throw new Error(`Client path ${path} collides with a Worker route`)
    }
    if (path !== paths.landing && !path.startsWith('/console')) {
      throw new Error(`Client path ${path} is outside the /console namespace`)
    }
  }
}
