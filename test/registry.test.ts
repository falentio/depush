import { exports } from 'cloudflare:workers'
import * as v from 'valibot'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { hmacHex, md5Hex, signingString } from '../src/signature'

const ORIGIN = 'http://depush.test'
const PASSWORD = 'correct-horse-battery-staple'

type AuthUser = { id: string; email: string; role: string | null }
type Client = { cookie: string }
type Json = Record<string, unknown>

const ADMIN_EMAIL = 'owner@example.com'

/**
 * The pool shares one registry across a file, so the owner account is created
 * once, before any test, and every other account gets a fresh email of its own.
 */
let admin: Client

beforeAll(async () => {
  admin = await ensureAdmin()
})

function testEmail(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}@example.com`
}

function request(path: string, init: RequestInit = {}) {
  return exports.default.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { origin: ORIGIN, ...init.headers },
  })
}

function as(client: Client, path: string, init: RequestInit = {}) {
  return request(path, { ...init, headers: { ...init.headers, cookie: client.cookie } })
}

const jsonListSchema = v.array(v.record(v.string(), v.unknown()))

async function readJsonList(client: Client, path: string): Promise<Json[]> {
  const response = await as(client, path)
  expect(response.status).toBe(200)
  const parsed = v.safeParse(jsonListSchema, await response.json())
  if (!parsed.success) throw new Error(`${path} did not return a JSON array`)
  return parsed.output
}

async function readJsonObject(client: Client, path: string): Promise<Json> {
  const response = await as(client, path)
  expect(response.status).toBe(200)
  const parsed = v.safeParse(v.record(v.string(), v.unknown()), await response.json())
  if (!parsed.success) throw new Error(`${path} did not return a JSON object`)
  return parsed.output
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

const signUpBodySchema = v.object({
  user: v.object({
    id: v.string(),
    email: v.string(),
    role: v.nullish(v.string()),
  }),
})

const appSchema = v.object({
  id: v.string(),
  key: v.string(),
  secret: v.string(),
  name: v.string(),
  created_at: v.number(),
})

const appOverviewSchema = v.object({
  id: v.string(),
  key: v.string(),
  name: v.string(),
  created_at: v.number(),
})

function readUser(body: unknown): AuthUser {
  const parsed = v.safeParse(signUpBodySchema, body)
  if (!parsed.success) throw new Error(`sign-up did not return a user: ${JSON.stringify(body)}`)
  return {
    id: parsed.output.user.id,
    email: parsed.output.user.email,
    role: parsed.output.user.role ?? null,
  }
}

async function attemptSignUp(email = testEmail('user')) {
  const response = await request(
    '/api/auth/sign-up/email',
    json({ email, password: PASSWORD, name: email }),
  )
  const body: unknown = await response.json()
  return { client: { cookie: cookieOf(response) }, status: response.status, body }
}

async function signUp(email = testEmail('user')) {
  const attempt = await attemptSignUp(email)
  return { ...attempt, user: readUser(attempt.body) }
}

function cookieOf(response: Response): string {
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

/** Signs back in when the registry outlives the file, and claims admin when it does not. */
async function ensureAdmin(): Promise<Client> {
  const response = await request(
    '/api/auth/sign-in/email',
    json({ email: ADMIN_EMAIL, password: PASSWORD }),
  )
  if (response.status === 200) {
    const client = { cookie: cookieOf(response) }
    expect(client.cookie).not.toBe('')
    return client
  }

  const { client, user } = await signUp(ADMIN_EMAIL)
  expect(user.role).toBe('admin')
  return client
}

async function createApp(client: Client, name: string) {
  const response = await as(client, '/api/apps', json({ name }))
  expect(response.status).toBe(201)
  const parsed = v.safeParse(appSchema, await response.json())
  if (!parsed.success) throw new Error('app create did not return an app')
  return parsed.output
}

describe('admin gate', () => {
  it('runs the registry middleware only under /api', async () => {
    const middleware = app.routes
      .filter((route) => route.method === 'ALL')
      .map((route) => route.path)

    expect(middleware).toContain('/api/*')
    const catchAll = app.routes.find((route) => route.method === 'ALL' && route.path === '/*')
    expect(catchAll?.handler.name).toBe('requestLogger')
    expect((await request('/healthz')).status).toBe(200)
  })

  it('rejects an anonymous request with 401', async () => {
    expect((await request('/api/apps')).status).toBe(401)
    expect((await request('/api/settings')).status).toBe(401)
  })

  it('does not run the handler behind a rejected request', async () => {
    const before = await readJsonList(admin, '/api/apps')

    const smuggled = await request('/api/apps', json({ name: 'smuggled' }))
    expect(smuggled.status).toBe(401)

    expect(await readJsonList(admin, '/api/apps')).toEqual(before)
  })

  it('rejects a signed-in non-admin with 403', async () => {
    const { client, user } = await signUp()
    expect(user.role).toBe('user')

    expect((await as(client, '/api/apps')).status).toBe(403)
    expect((await as(client, '/api/settings')).status).toBe(403)
    expect((await as(client, '/api/apps', json({ name: 'nope' }))).status).toBe(403)
  })
})

describe('app CRUD', () => {
  it('creates, lists, reads, and deletes an app', async () => {
    const app = await createApp(admin, 'round trip')

    expect(app.name).toBe('round trip')
    expect(String(app.id)).toMatch(/^[a-z0-9]{8}$/)
    expect(String(app.key)).toMatch(/^[0-9a-f]{32}$/)
    expect(String(app.secret)).toMatch(/^[0-9a-f]{32}$/)

    const list = await readJsonList(admin, '/api/apps')
    const listed = list.find((entry) => entry.id === app.id)
    expect(listed).toBeDefined()
    expect(listed).not.toHaveProperty('secret')

    const one = await readJsonObject(admin, `/api/apps/${app.id}`)
    expect(one).toEqual({ id: app.id, key: app.key, name: app.name, created_at: app.created_at })
    expect(one).not.toHaveProperty('secret')

    expect((await as(admin, `/api/apps/${app.id}`, { method: 'DELETE' })).status).toBe(204)
    const afterDelete = await readJsonList(admin, '/api/apps')
    expect(afterDelete.some((entry) => entry.id === app.id)).toBe(false)
    expect((await as(admin, `/api/apps/${app.id}`)).status).toBe(404)
  })

  it('renames an app and never returns its secret', async () => {
    const app = await createApp(admin, 'before')

    const response = await as(admin, `/api/apps/${app.id}`, {
      ...json({ name: 'after' }),
      method: 'PATCH',
    })
    expect(response.status).toBe(200)
    const parsed = v.safeParse(appOverviewSchema, await response.json())
    if (!parsed.success) throw new Error('app rename did not return an app overview')
    expect(parsed.output.name).toBe('after')
    expect(parsed.output).not.toHaveProperty('secret')

    expect((await readJsonObject(admin, `/api/apps/${app.id}`)).name).toBe('after')
    expect(
      (await as(admin, '/api/apps/missing', { ...json({ name: 'after' }), method: 'PATCH' }))
        .status,
    ).toBe(404)
  })

  it('rejects a blank name and an unknown app', async () => {
    expect((await as(admin, '/api/apps', json({ name: '   ' }))).status).toBe(400)
    expect((await as(admin, '/api/apps', json({}))).status).toBe(400)
    expect((await as(admin, '/api/apps/missing')).status).toBe(404)
  })

  it('issues distinct ids, keys, and secrets', async () => {
    const apps = await Promise.all([1, 2, 3].map((index) => createApp(admin, `gen-${index}`)))

    expect(new Set(apps.map((app) => app.id)).size).toBe(3)
    expect(new Set(apps.map((app) => app.key)).size).toBe(3)
    expect(new Set(apps.map((app) => app.secret)).size).toBe(3)
  })
})

describe('signup toggle', () => {
  afterEach(async () => {
    await as(admin, '/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signup_enabled: true }),
    })
  })

  it('refuses every sign-up once disabled', async () => {
    const patched = await as(admin, '/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signup_enabled: false }),
    })
    expect(patched.status).toBe(200)
    expect(await patched.json()).toEqual({ signup_enabled: false })

    const refused = await attemptSignUp()
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ message: 'Sign-up is disabled' })

    const enabled = await as(admin, '/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signup_enabled: true }),
    })
    expect(await enabled.json()).toEqual({ signup_enabled: true })

    const allowed = await signUp()
    expect(allowed.status).toBe(200)
    expect(allowed.user.role).toBe('user')
  })

  it('rejects a non-boolean payload', async () => {
    const response = await as(admin, '/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signup_enabled: 'yes' }),
    })
    expect(response.status).toBe(400)
  })
})

describe('an app created through the admin API', () => {
  it('publishes a signed event to a WebSocket connected with its key', async () => {
    const app = await createApp(admin, 'end to end')

    const response = await exports.default.fetch(`${ORIGIN}/app/${app.key}?protocol=7`, {
      headers: { upgrade: 'websocket' },
    })
    expect(response.status).toBe(101)
    const socket = response.webSocket
    if (socket === null) throw new Error('upgrade did not return a WebSocket')
    socket.accept()

    const frames: string[] = []
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') frames.push(event.data)
    })

    socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'public-e2e' } }))
    await waitFor(() => frames.some((frame) => frame.includes('subscription_succeeded')))

    const body = JSON.stringify({
      name: 'greeting',
      channels: ['public-e2e'],
      data: '{"hello":"world"}',
    })
    const published = await publish(app, body)
    expect(published.status).toBe(200)

    await waitFor(() => frames.some((frame) => frame.includes('"event":"greeting"')))
    expect(frames.at(-1)).toContain('hello')
    expect(frames.at(-1)).toContain('world')

    socket.close()
  })

  it('rejects a publish signed with the wrong secret', async () => {
    const app = await createApp(admin, 'wrong secret')
    const body = JSON.stringify({ name: 'x', channels: ['public-e2e'], data: '{}' })

    const published = await publish({ ...app, secret: 'f'.repeat(64) }, body)
    expect(published.status).toBe(401)
  })

  it('closes an unknown key with 4001', async () => {
    const response = await exports.default.fetch(`${ORIGIN}/app/not-a-key?protocol=7`, {
      headers: { upgrade: 'websocket' },
    })
    expect(response.status).toBe(101)
    const socket = response.webSocket
    if (socket === null) throw new Error('upgrade did not return a WebSocket')
    socket.accept()

    const frames: string[] = []
    let closeCode: number | null = null
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') frames.push(event.data)
    })
    socket.addEventListener('close', (event) => {
      closeCode = event.code
    })

    await waitFor(() => closeCode !== null)
    expect(closeCode).toBe(4001)
    expect(frames.some((frame) => frame.includes('4001'))).toBe(true)
  })
})

async function publish(app: { id: string; key: string; secret: string }, body: string) {
  const timestamp = Math.floor(Date.now() / 1000)
  const params = new URLSearchParams({
    auth_key: app.key,
    auth_timestamp: String(timestamp),
    auth_version: '1.0',
    body_md5: md5Hex(new TextEncoder().encode(body)),
  })
  params.set(
    'auth_signature',
    await hmacHex(app.secret, signingString('POST', `/apps/${app.id}/events`, params)),
  )
  return exports.default.fetch(`${ORIGIN}/apps/${app.id}/events?${params}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
