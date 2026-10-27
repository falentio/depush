export type ApiErrorKind = 'http' | 'network' | 'malformed'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number | null

  private constructor(kind: ApiErrorKind, message: string, status: number | null) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
  }

  static http(status: number, message: string): ApiError {
    return new ApiError('http', message, status)
  }

  static network(): ApiError {
    return new ApiError('network', "Can't reach depush. Try again.", null)
  }

  static malformed(detail: string): ApiError {
    return new ApiError('malformed', `Unexpected response from depush: ${detail}`, null)
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}

export function messageOf(error: unknown): string {
  if (isApiError(error)) return error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

export function toApiError(error: unknown): ApiError {
  return isApiError(error) ? error : ApiError.malformed(messageOf(error))
}

export type ErrorCopy = {
  title: string
  description: string
  action: 'retry' | 'sign-in' | 'refresh-role' | 'reload'
}

const SERVER_ERROR: ErrorCopy = {
  title: 'depush hit an error',
  description: 'The server could not complete the request. Try again in a moment.',
  action: 'retry',
}

/**
 * Status is the only thing that selects copy. The server's own message stays
 * the inline text on a form, where the operator needs the exact reason.
 */
export function errorCopy(error: ApiError): ErrorCopy {
  if (error.kind === 'network') {
    return {
      title: "Can't reach depush",
      description: 'Check your connection or the server, then try again.',
      action: 'retry',
    }
  }

  if (error.kind === 'malformed') {
    return {
      title: 'This console is out of date',
      description: 'Reload to get the latest version of the console.',
      action: 'reload',
    }
  }

  switch (error.status) {
    case 400:
      return { title: 'That request was not valid', description: error.message, action: 'retry' }
    case 401:
      return {
        title: 'Session expired',
        description: 'Sign in again to continue.',
        action: 'sign-in',
      }
    case 403:
      return {
        title: 'Access denied',
        description:
          error.message === 'Forbidden' ? 'Only an admin can manage apps.' : error.message,
        action: 'refresh-role',
      }
    case 404:
      return { title: 'Not found', description: error.message, action: 'retry' }
    case 409:
      return { title: 'That already exists', description: error.message, action: 'retry' }
    case 422:
      return {
        title: 'That did not validate',
        description: error.message,
        action: 'retry',
      }
    default:
      if (error.status !== null && error.status >= 500) return SERVER_ERROR
      return { title: 'Request failed', description: error.message, action: 'retry' }
  }
}
