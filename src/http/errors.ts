const STATUS_BY_CODE = {
  validation: 400,
  not_found: 404,
  conflict: 409,
  internal: 500,
} as const

export type ErrorCode = keyof typeof STATUS_BY_CODE

export class ApiError extends Error {
  readonly code: ErrorCode
  readonly details: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.details = details
  }
}

export function validationError(message: string, details?: unknown): ApiError {
  return new ApiError('validation', message, details)
}

export function errorResponse(error: ApiError): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }),
    {
      status: STATUS_BY_CODE[error.code],
      headers: { 'content-type': 'application/json' },
    },
  )
}

export function handleError(error: Error): Response {
  if (error instanceof ApiError) return errorResponse(error)
  console.error(error)
  return errorResponse(new ApiError('internal', 'Internal server error'))
}

export function handleNotFound(): Response {
  return errorResponse(new ApiError('not_found', 'Not found'))
}
