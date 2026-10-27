import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import PusherServer from 'pusher'
import Pusher from 'pusher-js'

/**
 * Smoke test against a running depush deployment. HTTP requests are signed by
 * hand and channel auth runs through a local app server, so this proves the
 * wire format rather than this codebase's own helpers.
 *
 *   DEPUSH_APP_ID=… DEPUSH_APP_KEY=… DEPUSH_APP_SECRET=… \
 *   DEPUSH_BASE_URL=https://depush.falent.workers.dev node scripts/smoke.mjs
 */

const BASE_URL = process.env.DEPUSH_BASE_URL ?? 'https://depush.falent.workers.dev'
const APP_ID = process.env.DEPUSH_APP_ID ?? ''
const APP_KEY = process.env.DEPUSH_APP_KEY ?? ''
const APP_SECRET = process.env.DEPUSH_APP_SECRET ?? ''
const TIMEOUT_MS = 15_000

for (const [name, value] of [
  ['DEPUSH_APP_ID', APP_ID],
  ['DEPUSH_APP_KEY', APP_KEY],
  ['DEPUSH_APP_SECRET', APP_SECRET],
]) {
  if (value === '') throw new Error(`${name} is required`)
}

const base = new URL(BASE_URL)
const HOST = base.hostname
const TLS = base.protocol === 'https:'
const PORT = base.port === '' ? (TLS ? 443 : 80) : Number(base.port)
const RUN = Date.now().toString(36)
const PUBLIC_CHANNEL = `smoke-public-${RUN}`
const PRIVATE_CHANNEL = `private-smoke-${RUN}`
const PRESENCE_CHANNEL = `presence-smoke-${RUN}`
const USER_ID = `smoke-${RUN}`

const results = []

async function check(name, body) {
  const index = results.length + 1
  try {
    await body()
    results.push({ name, error: null })
    console.log(`PASS ${index} ${name}`)
  } catch (error) {
    results.push({ name, error })
    console.log(`FAIL ${index} ${name}`)
    console.log(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}

function timeout(ms, label) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out: ${label}`)), ms))
}

function waitForEvent(binder, event, label = event) {
  return Promise.race([
    new Promise((resolve) => {
      const handler = (data) => {
        binder.unbind(event, handler)
        resolve(data)
      }
      binder.bind(event, handler)
    }),
    timeout(TIMEOUT_MS, label),
  ])
}

function signed(method, path, { query = {}, body, secret = APP_SECRET } = {}) {
  const params = new URLSearchParams(query)
  params.set('auth_key', APP_KEY)
  params.set('auth_timestamp', String(Math.floor(Date.now() / 1000)))
  params.set('auth_version', '1.0')
  const bodyText = body === undefined ? '' : JSON.stringify(body)
  if (bodyText !== '') params.set('body_md5', createHash('md5').update(bodyText).digest('hex'))
  const canonical = [...params.entries()]
    .map(([key, value]) => [key.toLowerCase(), value])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  const signature = createHmac('sha256', secret)
    .update(`${method.toUpperCase()}\n${path}\n${canonical}`)
    .digest('hex')
  params.set('auth_signature', signature)
  return {
    url: `${base.origin}${path}?${params.toString()}`,
    init: { method, headers: { 'content-type': 'application/json' }, body: bodyText || undefined },
  }
}

const server = new PusherServer({
  appId: APP_ID,
  key: APP_KEY,
  secret: APP_SECRET,
  host: HOST,
  port: String(PORT),
  useTLS: TLS,
})

/** The app server an operator runs: it signs channel auth and nothing else. */
const authServer = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk) => {
    raw += chunk
  })
  request.on('end', () => {
    const params = new URLSearchParams(raw)
    const socketId = params.get('socket_id') ?? ''
    const channelName = params.get('channel_name') ?? ''
    const channelData = channelName.startsWith('presence-')
      ? { user_id: USER_ID, user_info: { role: 'smoke' } }
      : undefined
    const body = server.authorizeChannel(socketId, channelName, channelData)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
})
await new Promise((resolve) => authServer.listen(0, '127.0.0.1', resolve))
const authPort = authServer.address().port

function createClient() {
  return new Pusher(APP_KEY, {
    cluster: 'mt1',
    wsHost: HOST,
    wsPort: PORT,
    wssPort: PORT,
    forceTLS: TLS,
    enabledTransports: ['ws'],
    disableStats: true,
    channelAuthorization: {
      endpoint: `http://127.0.0.1:${authPort}/auth`,
      transport: 'ajax',
    },
  })
}

function subscribe(pusher, name) {
  const channel = pusher.subscribe(name)
  return Promise.race([
    new Promise((resolve, reject) => {
      channel.bind('pusher:subscription_succeeded', (data) => resolve({ channel, data }))
      channel.bind('pusher:subscription_error', (error) =>
        reject(new Error(`subscription_error on ${name}: ${JSON.stringify(error)}`)),
      )
    }),
    timeout(TIMEOUT_MS, `subscribe ${name}`),
  ])
}

function connection(pusher) {
  return Promise.race([
    new Promise((resolve, reject) => {
      pusher.connection.bind('connected', () => resolve(pusher.connection.socket_id))
      pusher.connection.bind('failed', () => reject(new Error('connection failed')))
      pusher.connection.bind('unavailable', () => reject(new Error('connection unavailable')))
    }),
    timeout(TIMEOUT_MS, 'connect'),
  ])
}

const clients = []

try {
  await check('healthz answers ok', async () => {
    const response = await fetch(`${base.origin}/healthz`)
    const body = await response.json()
    if (response.status !== 200 || body.status !== 'ok') {
      throw new Error(`got ${response.status} ${JSON.stringify(body)}`)
    }
  })

  await check('signed channel query is accepted', async () => {
    const { url, init } = signed('GET', `/apps/${APP_ID}/channels`)
    const response = await fetch(url, init)
    if (response.status !== 200) throw new Error(`got ${response.status} ${await response.text()}`)
  })

  const client = createClient()
  clients.push(client)

  await check(`websocket connects over ${TLS ? 'wss' : 'ws'}`, async () => {
    const socketId = await connection(client)
    if (!/^\d+\.\d+$/.test(socketId)) throw new Error(`unexpected socket_id ${socketId}`)
  })

  await check('public channel subscribes', async () => {
    await subscribe(client, PUBLIC_CHANNEL)
  })

  await check('public event arrives with a unicode payload intact', async () => {
    const channel = client.channel(PUBLIC_CHANNEL)
    const payload = { hello: 'world', emoji: '🚀 ünïcode', nested: { count: 1 } }
    const received = waitForEvent(channel, 'greeting')
    await server.trigger(PUBLIC_CHANNEL, 'greeting', payload)
    const data = await received
    if (JSON.stringify(data) !== JSON.stringify(payload)) {
      throw new Error(`payload mismatch: ${JSON.stringify(data)}`)
    }
  })

  await check('private channel authorizes through the app server', async () => {
    await subscribe(client, PRIVATE_CHANNEL)
  })

  await check('private event arrives', async () => {
    const channel = client.channel(PRIVATE_CHANNEL)
    const received = waitForEvent(channel, 'secret')
    await server.trigger(PRIVATE_CHANNEL, 'secret', { level: 'high' })
    const data = await received
    if (data.level !== 'high') throw new Error(`payload mismatch: ${JSON.stringify(data)}`)
  })

  await check('presence channel reports one member', async () => {
    const { data } = await subscribe(client, PRESENCE_CHANNEL)
    if (data.count !== 1) throw new Error(`expected 1 member, got ${data.count}`)
    const ids = Object.keys(data.members ?? {})
    if (ids.length !== 1 || ids[0] !== USER_ID) {
      throw new Error(`unexpected members ${JSON.stringify(ids)}`)
    }
  })

  await check('presence event arrives', async () => {
    const channel = client.channel(PRESENCE_CHANNEL)
    const received = waitForEvent(channel, 'room')
    await server.trigger(PRESENCE_CHANNEL, 'room', { open: true })
    await received
  })

  await check('batch_events publishes every event', async () => {
    const channel = client.channel(PUBLIC_CHANNEL)
    const first = waitForEvent(channel, 'batch-one')
    const second = waitForEvent(channel, 'batch-two')
    const { url, init } = signed('POST', `/apps/${APP_ID}/batch_events`, {
      body: {
        batch: [
          { channel: PUBLIC_CHANNEL, name: 'batch-one', data: '{"index":1}' },
          { channel: PUBLIC_CHANNEL, name: 'batch-two', data: '{"index":2}' },
        ],
      },
    })
    const response = await fetch(url, init)
    if (response.status !== 200) throw new Error(`got ${response.status} ${await response.text()}`)
    const [one, two] = await Promise.all([first, second])
    if (one.index !== 1 || two.index !== 2) {
      throw new Error(`unexpected batch payloads ${JSON.stringify([one, two])}`)
    }
  })

  await check('channel query reports the subscriber count', async () => {
    const { url, init } = signed('GET', `/apps/${APP_ID}/channels`, {
      query: { info: 'subscription_count', filter_by_prefix: 'smoke-' },
    })
    const response = await fetch(url, init)
    const body = await response.json()
    const entry = body.channels?.[PUBLIC_CHANNEL]
    if (entry === undefined || entry.subscription_count !== 1) {
      throw new Error(`unexpected channel list ${JSON.stringify(body)}`)
    }
  })

  await check('history extension replays the published events', async () => {
    const { url, init } = signed('GET', `/apps/${APP_ID}/channels/${PUBLIC_CHANNEL}/history`, {
      query: { limit: '10' },
    })
    const response = await fetch(url, init)
    const body = await response.json()
    const names = (body.events ?? []).map((item) => item.name)
    for (const expected of ['greeting', 'batch-one', 'batch-two']) {
      if (!names.includes(expected)) {
        throw new Error(`history missing ${expected}: ${JSON.stringify(body)}`)
      }
    }
  })

  await check('unsigned publish is rejected', async () => {
    const response = await fetch(`${base.origin}/apps/${APP_ID}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'greeting', channel: PUBLIC_CHANNEL, data: '{}' }),
    })
    if (response.status !== 401) throw new Error(`expected 401, got ${response.status}`)
  })

  await check('wrong secret is rejected', async () => {
    const { url, init } = signed('POST', `/apps/${APP_ID}/events`, {
      body: { name: 'greeting', channel: PUBLIC_CHANNEL, data: '{}' },
      secret: 'not-the-secret',
    })
    const response = await fetch(url, init)
    if (response.status !== 401) throw new Error(`expected 401, got ${response.status}`)
  })

  await check('an unknown app key is refused with 4001', async () => {
    const scheme = TLS ? 'wss' : 'ws'
    const socket = new WebSocket(
      `${scheme}://${HOST}:${PORT}/app/unknown-key?protocol=7&client=js&version=8.6.0`,
    )
    const outcome = await Promise.race([
      new Promise((resolve) => {
        socket.addEventListener('message', (event) => {
          try {
            const frame = JSON.parse(String(event.data))
            if (frame.event === 'pusher:error') resolve(frame.data.code)
          } catch {}
        })
        socket.addEventListener('error', () => resolve('error'))
        socket.addEventListener('close', () => resolve('closed'))
      }),
      timeout(TIMEOUT_MS, 'unknown key socket'),
    ])
    socket.close()
    if (outcome !== 4001) throw new Error(`expected pusher:error 4001, got ${outcome}`)
  })
} finally {
  for (const client of clients) client.disconnect()
  authServer.close()
}

const failed = results.filter((result) => result.error !== null)
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed against ${base.origin}`,
)
if (failed.length > 0) process.exitCode = 1
