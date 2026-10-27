import type { Api } from '@/api/client'
import type { Session } from '@/api/contracts'
import { toApiError } from '@/api/errors'
import type { Auth, ProbedAuth, User } from './types'

export type Credentials = Parameters<Api['auth']['signIn']>[0]
export type SignUpInput = Parameters<Api['auth']['signUp']>[0]

export type AuthStore = {
  get(): Auth
  subscribe(listener: () => void): () => void
  /** Single-flight and cached. Resolves `unavailable`; never resolves `pending`. */
  ensure(): Promise<ProbedAuth>
  refresh(): Promise<ProbedAuth>
  /** POST, then probe. A failed POST throws and leaves the state untouched. */
  signIn(input: Credentials): Promise<ProbedAuth>
  signUp(input: SignUpInput): Promise<ProbedAuth>
  /** POST; a 401 counts as already signed out. */
  signOut(): Promise<void>
  /** Re-probes after a 401; a newer session is never overwritten. */
  expire(): Promise<void>
}

export function toAuth(session: Session | null): ProbedAuth {
  if (session === null) return { state: 'anonymous', reason: 'signed-out' }

  const user: User = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role === 'admin' ? 'admin' : 'user',
  }

  return user.role === 'admin' ? { state: 'admin', user } : { state: 'user', user }
}

export function createAuthStore(auth: Api['auth']): AuthStore {
  let state: Auth = { state: 'pending' }
  let generation = 0
  let inflight: Promise<ProbedAuth> | null = null
  const listeners = new Set<() => void>()

  function emit(): void {
    for (const listener of [...listeners]) listener()
  }

  function commit(next: ProbedAuth): ProbedAuth {
    generation += 1
    state = next
    emit()
    return next
  }

  function settled(): ProbedAuth | null {
    return state.state === 'pending' ? null : state
  }

  function isCurrent(started: number): boolean {
    return started === generation
  }

  function commitIfCurrent(started: number, next: ProbedAuth): ProbedAuth {
    return isCurrent(started) ? commit(next) : (settled() ?? next)
  }

  async function probe(): Promise<ProbedAuth> {
    try {
      return toAuth(await auth.readSession())
    } catch (error) {
      return { state: 'unavailable', error: toApiError(error) }
    }
  }

  function ensure(): Promise<ProbedAuth> {
    const current = settled()
    if (current !== null) return Promise.resolve(current)
    if (inflight !== null) return inflight

    const started = generation
    const running = probe().then((result) => commitIfCurrent(started, result))

    inflight = running
    void running.then(
      () => {
        if (inflight === running) inflight = null
      },
      () => {
        if (inflight === running) inflight = null
      },
    )
    return running
  }

  async function refresh(): Promise<ProbedAuth> {
    const started = generation
    const result = await probe()
    return commitIfCurrent(started, result)
  }

  async function signIn(input: Credentials): Promise<ProbedAuth> {
    await auth.signIn(input)
    generation += 1
    return refresh()
  }

  async function signUp(input: SignUpInput): Promise<ProbedAuth> {
    await auth.signUp(input)
    generation += 1
    return refresh()
  }

  async function signOut(): Promise<void> {
    try {
      await auth.signOut()
    } catch (error) {
      const apiError = toApiError(error)
      const alreadySignedOut = apiError.kind === 'http' && apiError.status === 401
      if (!alreadySignedOut) throw error
    }
    commit({ state: 'anonymous', reason: 'signed-out' })
  }

  async function expire(): Promise<void> {
    if (state.state !== 'admin' && state.state !== 'user') return
    const started = generation
    const next = await probe()
    if (!isCurrent(started)) return
    if (next.state !== 'anonymous') return
    commit({ state: 'anonymous', reason: 'expired' })
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    ensure,
    refresh,
    signIn,
    signUp,
    signOut,
    expire,
  }
}
