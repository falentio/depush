import { redirect } from '@tanstack/react-router'
import { guardedPath, paths } from '@/app/paths'
import { decide, type Requirement } from './policy'
import type { SettledAuth } from './types'

type GuardContext = { context: { auth: SettledAuth }; location: { pathname: string } }

/**
 * A redirect thrown here runs in route validation, before the loader, so a
 * non-admin never fetches admin data.
 */
export function requireAccess(requirement: Requirement) {
  return ({ context, location }: GuardContext): void => {
    const decision = decide(context.auth, requirement)
    if (decision.kind === 'allow') return
    if (decision.to === paths.signIn) signInRedirect(location)
    throw redirect({ to: decision.to })
  }
}

/** The only way into sign-in from a guarded deep link; an open redirect is unrepresentable. */
export function signInRedirect(location: { pathname: string }): never {
  throw redirect({
    to: paths.signIn,
    search: { redirect: guardedPath(location.pathname) },
  })
}
