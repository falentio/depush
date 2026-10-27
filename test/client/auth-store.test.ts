import { describe, expect, it, vi } from 'vitest'
import type { Api } from '@/api/client'
import type { Session } from '@/api/contracts'
import { createAuthStore, toAuth } from '@/auth/store'

function session(id: string, role: string | null = 'admin'): Session {
  return {
    user: {
      id,
      email: `${id}@example.com`,
      name: id,
      role,
    },
  }
}

function authWith(readSession: () => Promise<Session | null>): Api['auth'] {
  return {
    readSession,
    signIn: async () => undefined,
    signUp: async () => undefined,
    signOut: async () => undefined,
  }
}

describe('toAuth', () => {
  it('treats a missing session as signed out', () => {
    expect(toAuth(null)).toEqual({ state: 'anonymous', reason: 'signed-out' })
  })

  it.each([
    ['admin', 'admin'],
    ['user', 'user'],
    [null, 'user'],
    ['root', 'user'],
  ] as const)('maps role %s to %s', (role, state) => {
    expect(toAuth(session('a', role))).toMatchObject({ state, user: { id: 'a' } })
  })
})

describe('authStore.expire', () => {
  it('marks an admin session expired only when the server has no session', async () => {
    const readSession = vi.fn<() => Promise<Session | null>>()
    readSession.mockResolvedValueOnce(session('a'))
    readSession.mockResolvedValueOnce(null)
    const store = createAuthStore(authWith(readSession))

    await store.ensure()
    await store.expire()

    expect(store.get()).toMatchObject({ state: 'anonymous', reason: 'expired' })
  })

  it('leaves a newer session alone when a stale response arrives first', async () => {
    let resolveProbe: (value: Session | null) => void = () => undefined
    const staleProbe = new Promise<Session | null>((resolve) => {
      resolveProbe = resolve
    })
    const readSession = vi.fn<() => Promise<Session | null>>()
    readSession.mockResolvedValueOnce(session('a'))
    readSession.mockReturnValueOnce(staleProbe)
    readSession.mockResolvedValueOnce(session('b'))
    const store = createAuthStore(authWith(readSession))

    await store.ensure()
    const expiring = store.expire()
    await store.signIn({ email: 'b@example.com', password: 'secret' })
    resolveProbe(null)
    await expiring

    expect(store.get()).toMatchObject({ state: 'admin', user: { id: 'b' } })
  })
})
