import { describe, expect, it } from 'vitest'
import { paths } from '@/app/paths'
import { decide, GUARDS, landingFor, type Requirement } from '@/auth/policy'
import type { AccessState, SettledAuth } from '@/auth/types'

const authFor = (state: AccessState): SettledAuth => {
  if (state === 'anonymous') return { state: 'anonymous', reason: 'signed-out' }
  const user = { id: 'u1', email: 'a@example.com', name: 'A', role: state }
  return state === 'admin' ? { state: 'admin', user } : { state: 'user', user }
}

const requirements: Requirement[] = ['anonymous-only', 'authenticated', 'admin']
const states: AccessState[] = ['anonymous', 'user', 'admin']

describe('GUARDS', () => {
  it.each(requirements)('covers every access state for %s', (requirement) => {
    for (const state of states) {
      expect(GUARDS[requirement][state]).toBeDefined()
    }
  })

  it.each([
    ['anonymous-only', 'anonymous', { kind: 'allow' }],
    ['anonymous-only', 'user', { kind: 'redirect', to: paths.forbidden }],
    ['anonymous-only', 'admin', { kind: 'redirect', to: paths.apps }],
    ['authenticated', 'anonymous', { kind: 'redirect', to: paths.signIn }],
    ['authenticated', 'user', { kind: 'allow' }],
    ['authenticated', 'admin', { kind: 'allow' }],
    ['admin', 'anonymous', { kind: 'redirect', to: paths.signIn }],
    ['admin', 'user', { kind: 'redirect', to: paths.forbidden }],
    ['admin', 'admin', { kind: 'allow' }],
  ] as const)('decides %s for %s', (requirement, state, expected) => {
    expect(decide(authFor(state), requirement)).toEqual(expected)
  })
})

describe('landingFor', () => {
  it('sends anonymous to sign-in', () => {
    expect(landingFor(authFor('anonymous'))).toBe(paths.signIn)
  })

  it('sends admin to apps', () => {
    expect(landingFor(authFor('admin'))).toBe(paths.apps)
  })

  it('sends a non-admin to forbidden', () => {
    expect(landingFor(authFor('user'))).toBe(paths.forbidden)
  })
})
