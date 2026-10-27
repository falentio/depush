import { type KnownPath, paths } from '@/app/paths'
import type { AccessState, SettledAuth } from './types'

export type Requirement = 'public' | 'anonymous-only' | 'authenticated' | 'admin'

export type Decision = { kind: 'allow' } | { kind: 'redirect'; to: KnownPath }

const allow: Decision = { kind: 'allow' }
const toSignIn: Decision = { kind: 'redirect', to: paths.signIn }
const toApps: Decision = { kind: 'redirect', to: paths.apps }
const toForbidden: Decision = { kind: 'redirect', to: paths.forbidden }

export const GUARDS: Record<Requirement, Record<AccessState, Decision>> = {
  public: { anonymous: allow, user: allow, admin: allow },
  'anonymous-only': { anonymous: allow, user: toForbidden, admin: toApps },
  authenticated: { anonymous: toSignIn, user: allow, admin: allow },
  admin: { anonymous: toSignIn, user: toForbidden, admin: allow },
}

export function decide(auth: SettledAuth, requirement: Requirement): Decision {
  return GUARDS[requirement][auth.state]
}

export function landingFor(auth: SettledAuth): KnownPath {
  switch (auth.state) {
    case 'anonymous':
      return paths.signIn
    case 'admin':
      return paths.apps
    case 'user':
      return paths.forbidden
  }
}
