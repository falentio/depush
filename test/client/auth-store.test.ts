import { describe, expect, it, vi } from 'vitest'
import type { Api } from '@/api/client'
import type { Session } from '@/api/contracts'
import { createAuthStore } from '@/auth/store'

function session(id: string): Session {
  return {
    user: {
      id,
      email: `${id}@example.com`,
      name: id,
      role: 'admin',
    },
  }
}

function authWith(readSession: ReturnType<typeof vi.fn>): Api['auth'] {
  return {
    readSession,
    signIn: vi.fn(async () => undefined),
    signUp: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
  } as unknown as Api['auth']
}

describe('authStore.expire', () => {
  it('marks an admin session expired only when the server has no session', async () => {
    const readSession = vi.fn()
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
    const readSession = vi.fn()
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
