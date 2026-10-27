import { isApiError, messageOf } from '@/api/errors'

export function formAuthError(error: unknown, options?: { duplicateEmail?: boolean }): string {
  if (isApiError(error)) {
    if (options?.duplicateEmail === true && error.status === 422) {
      return 'An account with that email already exists.'
    }
    if (error.kind === 'network') return "Can't reach depush. Try again."
  }
  return messageOf(error)
}
