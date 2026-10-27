import type { ApiError } from '@/api/errors'
import type { User } from '@/api/contracts'

export type { User }

export type Auth =
  | { state: 'pending' }
  | { state: 'anonymous'; reason: 'signed-out' | 'expired' }
  | { state: 'admin'; user: User }
  | { state: 'user'; user: User }
  | { state: 'unavailable'; error: ApiError }

/** The probe finished. `pending` never escapes the store's ensure(). */
export type ProbedAuth = Exclude<Auth, { state: 'pending' }>

/** A probe finished with an answer the guards can use. */
export type SettledAuth = Extract<Auth, { state: 'anonymous' | 'admin' | 'user' }>

export type AccessState = SettledAuth['state']

export class AuthUnavailableError extends Error {
  readonly error: ApiError

  constructor(error: ApiError) {
    super('Authentication is unavailable')
    this.name = 'AuthUnavailableError'
    this.error = error
  }
}

export function isAuthUnavailableError(value: unknown): value is AuthUnavailableError {
  return value instanceof AuthUnavailableError
}
