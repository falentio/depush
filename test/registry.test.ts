import { exports } from 'cloudflare:workers'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { hmacHex, md5Hex, signingString } from '../src/signature'

const ORIGIN = 'http://depush.test'
const PASSWORD = 'correct-horse-battery-staple'

type AuthUser = { id: string; email: string; role: string | null }
type Client = { cookie: string }
type Json = Record<string, unknown>

const ADMIN_EMAIL = 'owner@example.com'

let run = 0
let adminCookie: string | null = null

/** The pool shares one registry across a file, so every account needs its own email. */
function nextEmail(prefix: string): string {
  run += 1
  return `${prefix}-${run}@example.com`
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

function readUser(body: unknown): AuthUser {
  const parsed = v.safeParse(signUpBodySchema, body)
  if (!parsed.success) throw new Error(`sign-up did not return a user: ${JSON.stringify(body)}`)
  return {
    id: parsed.output.user.id,
    email: parsed.output.user.email,
    role: parsed.output.user.role ?? null,
  }
}

async function attemptSignUp(email = nextEmail('user')) {
  const response = await request(
    '/api/auth/sign-up/email',
    json({ email, password: PASSWORD, name: email }),
  )
  const body: unknown = await response.json()
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { client: { cookie }, status: response.status, body }
}

async function signUp(email = nextEmail('user')) {
  const attempt = await attemptSignUp(email)
  return { ...attempt, user: readUser(attempt.body) }
}

/**
 * The pool shares one registry across the file, so the account that owns admin
 * is created once and every later test signs back in as it.
 */
async function adminClient(): Promise<Client> {
  if (adminCookie !== null) return { cookie: adminCookie }

  const response = await request(
    '/api/auth/sign-in/email',
    json({ email: ADMIN_EMAIL, password: PASSWORD }),
  )
  if (response.status === 200) {
    adminCookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect(adminCookie).not.toBe('')
    return { cookie: adminCookie }
  }

  const { client, user } = await signUp(ADMIN_EMAIL)
  expect(user.role).toBe('admin')
  adminCookie = client.cookie
  return client
}

async function createApp(client: Client, name: string) {
  const response = await as(client, '/api/apps', json({ name }))
  expect(response.status).toBe(201)
  const parsed = v.safeParse(appSchema, await response.json())
  if (!parsed.success) throw new Error('app create did not return an app')
  return parsed.output
}

describe('the first account', () => {
  it('becomes admin, and the setting starts enabled', async () => {
    const { client, user } = await signUp(ADMIN_EMAIL)
    expect(user.role).toBe('admin')
    adminCookie = client.cookie

    const settings = await as(client, '/api/settings')
    expect(settings.status).toBe(200)
    expect(await settings.json()).toEqual({ signup_enabled: true })
  })

  it('is followed by a plain user', async () => {
    const { user } = await signUp()
    expect(user.role).toBe('user')
  })
})

describe('admin gate', () => {
  it('rejects an anonymous request with 401', async () => {
    expect((await request('/api/apps')).status).toBe(401)
    expect((await request('/api/settings')).status).toBe(401)
  })

  it('does not run the handler behind a rejected request', async () => {
    const client = await adminClient()
    const before = await readJsonList(client, '/api/apps')

    const smuggled = await request('/api/apps', json({ name: 'smuggled' }))
    expect(smuggled.status).toBe(401)

    expect(await readJsonList(client, '/api/apps')).toEqual(before)
  })

  it('rejects a signed-in non-admin with 403', async () => {
    await adminClient()
    const { client, user } = await signUp()
    expect(user.role).toBe('user')

    expect((await as(client, '/api/apps')).status).toBe(403)
    expect((await as(client, '/api/settings')).status).toBe(403)
    expect((await as(client, '/api/apps', json({ name: 'nope' }))).status).toBe(403)
  })
})

describe('app CRUD', () => {
  it('creates, lists, reads, and deletes an app', async () => {
    const client = await adminClient()
    const app = await createApp(client, 'round trip')

    expect(app.name).toBe('round trip')
    expect(String(app.id)).toMatch(/^[a-z0-9]{8}$/)
    expect(String(app.key)).toMatch(/^[0-9a-f]{32}$/)
    expect(String(app.secret)).toMatch(/^[0-9a-f]{32}$/)

    const list = await readJsonList(client, '/api/apps')
    const listed = list.find((entry) => entry.id === app.id)
    expect(listed).toBeDefined()
    expect(listed).not.toHaveProperty('secret')

    const one = await readJsonObject(client, `/api/apps/${app.id}`)
    expect(one).toEqual({ id: app.id, key: app.key, name: app.name, created_at: app.created_at })
    expect(one).not.toHaveProperty('secret')

    expect((await as(client, `/api/apps/${app.id}`, { method: 'DELETE' })).status).toBe(204)
    const afterDelete = await readJsonList(client, '/api/apps')
    expect(afterDelete.some((entry) => entry.id === app.id)).toBe(false)
    expect((await as(client, `/api/apps/${app.id}`)).status).toBe(404)
  })

  it('rejects a blank name and an unknown app', async () => {
    const client = await adminClient()
    expect((await as(client, '/api/apps', json({ name: '   ' }))).status).toBe(400)
    expect((await as(client, '/api/apps', json({}))).status).toBe(400)
    expect((await as(client, '/api/apps/missing')).status).toBe(404)
  })

  it('issues distinct ids, keys, and secrets', async () => {
    const client = await adminClient()
    const apps = await Promise.all([1, 2, 3].map((index) => createApp(client, `gen-${index}`)))

    expect(new Set(apps.map((app) => app.id)).size).toBe(3)
    expect(new Set(apps.map((app) => app.key)).size).toBe(3)
    expect(new Set(apps.map((app) => app.secret)).size).toBe(3)
  })
})

describe('signup toggle', () => {
  it('refuses every sign-up once disabled', async () => {
    const client = await adminClient()

    const patched = await as(client, '/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signup_enabled: false }),
    })
    expect(patched.status).toBe(200)
    expect(await patched.json()).toEqual({ signup_enabled: false })

    const refused = await attemptSignUp()
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ message: 'Sign-up is disabled' })

    const enabled = await as(client, '/api/settings', {
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
    const client = await adminClient()
    const response = await as(client, '/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signup_enabled: 'yes' }),
    })
    expect(response.status).toBe(400)
  })
})

describe('an app created through the admin API', () => {
  it('publishes a signed event to a WebSocket connected with its key', async () => {
    const client = await adminClient()
    const app = await createApp(client, 'end to end')

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
    const client = await adminClient()
    const app = await createApp(client, 'wrong secret')
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
