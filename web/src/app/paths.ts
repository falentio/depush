import * as v from 'valibot'

/** A client path: the root or anything under the console namespace. */
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

/** Paths the Worker owns. Nothing under these may become a client route. */
export const WORKER_PREFIXES = ['/api', '/apps', '/app', '/healthz'] as const

export const signInSearchSchema = v.object({
  redirect: v.fallback(v.picklist([paths.apps, paths.settings]), paths.apps),
})

export type SignInSearch = v.InferOutput<typeof signInSearchSchema>

/** Only the two pages a signed-in operator can return to after sign-in. */
export function guardedPath(pathname: string): KnownPath {
  return pathname === paths.settings ? paths.settings : paths.apps
}

export function isWorkerPath(pathname: string): boolean {
  return WORKER_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

/** Fails the build if a client path could shadow a Worker route. */
export function assertRouteNamespace(clientPaths: readonly string[]): void {
  for (const path of clientPaths) {
    if (path !== paths.landing && !path.startsWith('/console')) {
      throw new Error(`Client path ${path} is outside the /console namespace`)
    }
    if (isWorkerPath(path)) {
      throw new Error(`Client path ${path} collides with a Worker route`)
    }
  }
}
