import * as v from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, errorCopy } from '@/api/errors'
import { createHttp } from '@/api/http'

const okBody = v.object({ ok: v.boolean() })

function respond(body: string, status = 200, statusText = 'OK'): Response {
  return new Response(body, {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      if (response instanceof Error) throw response
      return response
    },
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function initOf(fetchMock: ReturnType<typeof stubFetch>): RequestInit {
  const init = fetchMock.mock.calls[0]?.[1]
  if (init === undefined) throw new Error('fetch was called without init')
  return init
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createHttp', () => {
  it('parses a 200 JSON body with the schema', async () => {
    const fetchMock = stubFetch(respond('{"ok":true}'))
    const http = createHttp()

    await expect(http.json('GET', '/api/apps', okBody)).resolves.toEqual({ ok: true })

    const init = initOf(fetchMock)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/apps')
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('same-origin')
    expect(init.cache).toBe('no-store')
    expect(init.headers).toEqual({ accept: 'application/json' })
    expect(init.body).toBeUndefined()
  })

  it('sends JSON and the content-type only when a body is present', async () => {
    const fetchMock = stubFetch(respond('{"ok":true}'))
    const http = createHttp()

    await http.json('POST', '/api/apps', okBody, { body: { name: 'demo' } })

    const init = initOf(fetchMock)
    expect(init.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
    })
    expect(init.body).toBe('{"name":"demo"}')
  })

  it('accepts 204 with no body', async () => {
    stubFetch(new Response(null, { status: 204 }))
    const http = createHttp()

    await expect(http.empty('DELETE', '/api/apps/abcdefgh')).resolves.toBeUndefined()
  })

  it('does not expire the session when the caller opts out', async () => {
    stubFetch(respond('{"message":"Invalid email or password"}', 401, 'Unauthorized'))
    const http = createHttp()
    const expired = vi.fn()
    http.onSessionExpired(expired)

    await expect(
      http.empty('POST', '/api/auth/sign-in/email', {
        body: { email: 'a', password: 'b' },
        expireSession: false,
      }),
    ).rejects.toMatchObject({
      kind: 'http',
      status: 401,
      message: 'Invalid email or password',
    })

    expect(expired).not.toHaveBeenCalled()
  })

  it('expires the session on a 401 from an admin path', async () => {
    stubFetch(respond('{"error":"Unauthorized"}', 401, 'Unauthorized'))
    const http = createHttp()
    const expired = vi.fn()
    http.onSessionExpired(expired)

    await expect(http.json('GET', '/api/apps', okBody)).rejects.toMatchObject({
      kind: 'http',
      status: 401,
      message: 'Unauthorized',
    })

    expect(expired).toHaveBeenCalledTimes(1)
  })

  it('reads the error envelope from {error} and {message}', async () => {
    stubFetch(respond('{"error":"Forbidden"}', 403, 'Forbidden'))
    const forbidden = createHttp()
    await expect(forbidden.json('GET', '/api/apps', okBody)).rejects.toMatchObject({
      status: 403,
      message: 'Forbidden',
    })

    stubFetch(
      respond('{"message":"An account with that email already exists."}', 422, 'Unprocessable'),
    )
    const duplicate = createHttp()
    await expect(
      duplicate.empty('POST', '/api/auth/sign-up/email', { body: {} }),
    ).rejects.toMatchObject({
      status: 422,
      message: 'An account with that email already exists.',
    })
  })

  it('turns a non-JSON 2xx body into a malformed error', async () => {
    stubFetch(respond('not json'))
    const http = createHttp()

    await expect(http.json('GET', '/api/apps', okBody)).rejects.toMatchObject({
      kind: 'malformed',
    })
  })

  it('turns a schema mismatch into a malformed error', async () => {
    stubFetch(respond('{"ok":"yes"}'))
    const http = createHttp()

    await expect(http.json('GET', '/api/apps', okBody)).rejects.toMatchObject({
      kind: 'malformed',
    })
  })

  it('turns a rejected fetch into a network error', async () => {
    stubFetch(new Error('offline'))
    const http = createHttp()

    await expect(http.json('GET', '/api/apps', okBody)).rejects.toMatchObject({
      kind: 'network',
    })
  })

  it('maps status to error copy without splitting error classes', () => {
    expect(errorCopy(ApiError.http(401, 'Unauthorized')).action).toBe('sign-in')
    expect(errorCopy(ApiError.http(403, 'Forbidden')).action).toBe('refresh-role')
    expect(errorCopy(ApiError.http(422, 'Bad')).title).toBe('That did not validate')
    expect(errorCopy(ApiError.http(500, 'Boom')).action).toBe('retry')
    expect(errorCopy(ApiError.network()).title).toBe("Can't reach depush")
    expect(errorCopy(ApiError.malformed('bad')).action).toBe('reload')
  })
})
