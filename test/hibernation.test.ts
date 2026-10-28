import { evictDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hmacHex, md5Hex, signingString } from '../src/signature'

const ORIGIN = 'http://depush.test'

type App = { id: string; key: string; secret: string; name: string; created_at: number }
type Frame = {
  event: string
  channel?: string | undefined
  data?: unknown
  user_id?: string | undefined
}

type Client = {
  socket: WebSocket
  frames: Frame[]
  closeCode: number | null
  closeWasClean: boolean | null
  socketId: string
  subscribe: (channel: string, channelData?: string, secret?: string) => void
}

async function createApp(name: string): Promise<App> {
  const app = await env.REGISTRY.get(env.REGISTRY.idFromName('registry')).createApp(name)
  if (app === null) throw new Error('the registry refused to create an app')
  return app
}

async function evictHub(app: App): Promise<void> {
  await evictDurableObject(env.APP_HUB.get(env.APP_HUB.idFromName(app.id)))
}

async function connect(app: App): Promise<Client> {
  const response = await exports.default.fetch(`${ORIGIN}/app/${app.key}?protocol=7`, {
    headers: { upgrade: 'websocket' },
  })
  expect(response.status).toBe(101)
  const socket = response.webSocket
  if (socket === null) throw new Error('the upgrade did not return a WebSocket')
  socket.accept()

  const client: Client = {
    socket,
    frames: [],
    closeCode: null,
    closeWasClean: null,
    socketId: '',
    subscribe: (channel, channelData, secret = app.secret) => {
      const signed = `${client.socketId}:${channel}${channelData === undefined ? '' : `:${channelData}`}`
      void hmacHex(secret, signed).then((signature) => {
        socket.send(
          JSON.stringify({
            event: 'pusher:subscribe',
            data: {
              channel,
              auth: `${app.key}:${signature}`,
              ...(channelData === undefined ? {} : { channel_data: channelData }),
            },
          }),
        )
      })
    },
  }

  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return
    client.frames.push(JSON.parse(event.data) as Frame)
  })
  socket.addEventListener('close', (event) => {
    client.closeCode = event.code
    client.closeWasClean = event.wasClean
  })

  await waitFor(() => find(client, 'pusher:connection_established') !== undefined)
  const established = find(client, 'pusher:connection_established')
  client.socketId = JSON.parse(String(established?.data)).socket_id
  return client
}

function find(client: Client, event: string, channel?: string): Frame | undefined {
  return client.frames.find(
    (frame) => frame.event === event && (channel === undefined || frame.channel === channel),
  )
}

function error(client: Client): { message: string; code: number } | null {
  const frame = find(client, 'pusher:error')
  return frame === undefined ? null : (frame.data as { message: string; code: number })
}

async function publish(app: App, body: string): Promise<Response> {
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

async function signedGet(app: App, path: string): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000)
  const params = new URLSearchParams({
    auth_key: app.key,
    auth_timestamp: String(timestamp),
    auth_version: '1.0',
  })
  params.set('auth_signature', await hmacHex(app.secret, signingString('GET', path, params)))
  return exports.default.fetch(`${ORIGIN}${path}?${params}`)
}

function loggedMessages(calls: unknown[][]): string[] {
  return calls.map((call) => {
    const record = JSON.parse(String(call[0])) as { message: string }
    return record.message
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('the hub across a Durable Object hibernation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps an open socket and its public subscription', async () => {
    const app = await createApp('hibernation-public')
    const client = await connect(app)

    client.subscribe('public-room')
    await waitFor(
      () => find(client, 'pusher_internal:subscription_succeeded', 'public-room') !== undefined,
    )

    await evictHub(app)

    client.subscribe('public-other')
    await waitFor(
      () => find(client, 'pusher_internal:subscription_succeeded', 'public-other') !== undefined,
    )
    expect(error(client)).toBeNull()
  })

  it('accepts a private subscribe after the hub is evicted', async () => {
    const app = await createApp('hibernation-private')
    const client = await connect(app)

    client.subscribe('private-one')
    await waitFor(
      () => find(client, 'pusher_internal:subscription_succeeded', 'private-one') !== undefined,
    )

    await evictHub(app)

    client.subscribe('private-two')
    await waitFor(
      () =>
        error(client) !== null ||
        find(client, 'pusher_internal:subscription_succeeded', 'private-two') !== undefined,
    )

    expect(error(client)).toBeNull()
    expect(find(client, 'pusher_internal:subscription_succeeded', 'private-two')).toBeDefined()
  })

  it('accepts a presence subscribe after the hub is evicted', async () => {
    const app = await createApp('hibernation-presence')
    const client = await connect(app)
    const channelData = JSON.stringify({ user_id: 'alice', user_info: { name: 'Alice' } })

    client.subscribe('presence-room', channelData)
    await waitFor(
      () => find(client, 'pusher_internal:subscription_succeeded', 'presence-room') !== undefined,
    )

    await evictHub(app)

    client.subscribe('presence-other', channelData)
    await waitFor(
      () =>
        error(client) !== null ||
        find(client, 'pusher_internal:subscription_succeeded', 'presence-other') !== undefined,
    )

    expect(error(client)).toBeNull()
    expect(find(client, 'pusher_internal:subscription_succeeded', 'presence-other')).toBeDefined()
  })

  it('keeps the socket attachment readable after the hub is evicted', async () => {
    const app = await createApp('hibernation-attachment')
    const client = await connect(app)

    client.subscribe('presence-attached', JSON.stringify({ user_id: 'alice', user_info: {} }))
    await waitFor(
      () =>
        find(client, 'pusher_internal:subscription_succeeded', 'presence-attached') !== undefined,
    )

    await evictHub(app)

    const response = await signedGet(app, `/apps/${app.id}/channels/presence-attached/users`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ users: [{ id: 'alice' }] })
  })

  it('delivers a publish to a socket that hibernated', async () => {
    const app = await createApp('hibernation-publish')
    const client = await connect(app)

    client.subscribe('public-wake')
    await waitFor(
      () => find(client, 'pusher_internal:subscription_succeeded', 'public-wake') !== undefined,
    )

    await evictHub(app)

    const published = await publish(
      app,
      JSON.stringify({ name: 'greeting', channels: ['public-wake'], data: '{"hello":"world"}' }),
    )
    expect(published.status).toBe(200)

    await waitFor(() => find(client, 'greeting', 'public-wake') !== undefined)
    expect(find(client, 'greeting', 'public-wake')?.data).toBe('{"hello":"world"}')
  })

  it('completes the close handshake for a socket that hibernated', async () => {
    const app = await createApp('hibernation-close')
    const client = await connect(app)

    await evictHub(app)

    client.socket.close(1000, 'done')
    await waitFor(() => client.closeWasClean !== null)
    expect(client.closeWasClean).toBe(true)
  })

  it('completes the close handshake when the client sends no code', async () => {
    const app = await createApp('hibernation-close-no-code')
    const client = await connect(app)

    await evictHub(app)

    client.socket.close()
    await waitFor(() => client.closeWasClean !== null)
    expect(client.closeWasClean).toBe(true)
  })

  it('rejects a subscribe signed with another app secret after eviction', async () => {
    const app = await createApp('hibernation-foreign-secret')
    const other = await createApp('hibernation-other-secret')
    const client = await connect(app)

    await evictHub(app)

    client.subscribe('private-foreign', undefined, other.secret)
    await waitFor(() => error(client) !== null || find(client, 'pusher_internal:subscription_succeeded', 'private-foreign') !== undefined)

    expect(error(client)?.code).toBe(4009)
  })

  it('rejects a private subscribe with no auth after eviction', async () => {
    const app = await createApp('hibernation-no-auth')
    const client = await connect(app)

    await evictHub(app)

    client.socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'private-bare' } }))
    await waitFor(() => error(client) !== null || find(client, 'pusher_internal:subscription_succeeded', 'private-bare') !== undefined)

    expect(error(client)?.code).toBe(4009)
  })

  it('closes the socket when the app no longer exists', async () => {
    const app = await createApp('hibernation-deleted-app')
    const client = await connect(app)
    const warn = vi.spyOn(console, 'warn')

    await env.REGISTRY.get(env.REGISTRY.idFromName('registry')).deleteApp(app.id)
    await evictHub(app)

    client.subscribe('private-gone')
    await waitFor(() => error(client) !== null)

    expect(error(client)?.code).toBe(4001)
    expect(loggedMessages(warn.mock.calls)).toContain('config_missing')
    expect(loggedMessages(warn.mock.calls)).toContain('subscribe_refused')
  })

  it('delivers a client event between sockets that hibernated', async () => {
    const app = await createApp('hibernation-client-event')
    const alice = await connect(app)
    const bob = await connect(app)
    const aliceData = JSON.stringify({ user_id: 'alice', user_info: { name: 'Alice' } })
    const bobData = JSON.stringify({ user_id: 'bob', user_info: { name: 'Bob' } })

    alice.subscribe('presence-chat', aliceData)
    bob.subscribe('presence-chat', bobData)
    await waitFor(() => find(bob, 'pusher_internal:subscription_succeeded', 'presence-chat') !== undefined)

    await evictHub(app)

    alice.socket.send(
      JSON.stringify({ event: 'client-typing', channel: 'presence-chat', data: { at: 1 } }),
    )

    await waitFor(() => find(bob, 'client-typing', 'presence-chat') !== undefined)
    expect(find(bob, 'client-typing', 'presence-chat')?.user_id).toBe('alice')
  })
})
