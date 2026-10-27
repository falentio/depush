import * as v from 'valibot'
import { errorBodySchema } from './contracts'
import { ApiError } from './errors'

export type ApiPath = `/api${string}`
export type JsonMethod = 'GET' | 'POST' | 'PATCH'
export type EmptyMethod = 'POST' | 'DELETE'

type RequestOptions = { body?: unknown; expireSession?: boolean }

export type Http = {
  json<T>(
    method: JsonMethod,
    path: ApiPath,
    schema: v.GenericSchema<unknown, T>,
    options?: RequestOptions,
  ): Promise<T>
  empty(method: EmptyMethod, path: ApiPath, options?: RequestOptions): Promise<void>
  onSessionExpired(handler: () => void): void
}

export function createHttp(): Http {
  let sessionExpired: (() => void) | null = null

  async function send(method: string, path: ApiPath, options?: RequestOptions): Promise<Response> {
    const hasBody = options !== undefined && 'body' in options
    const headers: Record<string, string> = { accept: 'application/json' }
    if (hasBody) headers['content-type'] = 'application/json'

    const init: RequestInit = {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
    }
    if (hasBody) init.body = JSON.stringify(options.body)

    try {
      return await fetch(path, init)
    } catch {
      throw ApiError.network()
    }
  }

  async function fail(response: Response, expireSession: boolean): Promise<never> {
    const body = await response.text().catch(() => '')
    let message = response.statusText || `Request failed with ${response.status}`

    if (body !== '') {
      try {
        const parsed = v.safeParse(errorBodySchema, JSON.parse(body))
        if (parsed.success) {
          const serverMessage = parsed.output.error ?? parsed.output.message
          if (serverMessage !== undefined && serverMessage !== '') message = serverMessage
        }
      } catch {}
    }

    if (response.status === 401 && expireSession) {
      sessionExpired?.()
    }

    throw ApiError.http(response.status, message)
  }

  return {
    async json(method, path, schema, options) {
      const response = await send(method, path, options)
      if (!response.ok) return fail(response, options?.expireSession !== false)

      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw ApiError.malformed('the response was not JSON')
      }

      const parsed = v.safeParse(schema, body)
      if (!parsed.success) throw ApiError.malformed(v.summarize(parsed.issues))
      return parsed.output
    },

    async empty(method, path, options) {
      const response = await send(method, path, options)
      if (!response.ok) return fail(response, options?.expireSession !== false)
      await response.text()
    },

    onSessionExpired(handler) {
      sessionExpired = handler
    },
  }
}
