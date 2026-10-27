import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import PusherServer from 'pusher'
import Pusher from 'pusher-js'

const HOST = '127.0.0.1'
const DEFAULT_PORT = 8787
const APP_ID = '1'
const APP_KEY = 'test-key'
const APP_SECRET = 'test-secret'
const CHANNEL = 'public-smoke'
const PRIVATE_CHANNEL = 'private-room'
const PRESENCE_CHANNEL = 'presence-room'
const DEV_VARS = '.dev.vars'
const DEV_VARS_BACKUP = '.dev.vars.compat-backup'
const DEV_VARS_CONTENT = [
  `PUSHER_APP_ID=${APP_ID}`,
  `PUSHER_APP_KEY=${APP_KEY}`,
  `PUSHER_APP_SECRET=${APP_SECRET}`,
  'PUSHER_ACTIVITY_TIMEOUT=1',
  '',
].join('\n')

let serverLog = ''

async function findFreePort(start) {
  for (let port = start; port < start + 20; port += 1) {
    if (await isPortFree(port)) return port
  }
  throw new Error(`No free port between ${start} and ${start + 19}`)
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, HOST)
  })
}

function backupDevVars() {
  if (existsSync(DEV_VARS)) renameSync(DEV_VARS, DEV_VARS_BACKUP)
  writeFileSync(DEV_VARS, DEV_VARS_CONTENT)
}

function restoreDevVars() {
  if (existsSync(DEV_VARS_BACKUP)) {
    renameSync(DEV_VARS_BACKUP, DEV_VARS)
  } else if (existsSync(DEV_VARS)) {
    unlinkSync(DEV_VARS)
  }
}

function startServer(port) {
  const child = spawn(
    'pnpm',
    ['exec', 'vite', '--host', HOST, '--port', String(port), '--strictPort'],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const collect = (chunk) => {
    serverLog = `${serverLog}${chunk}`.slice(-8000)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  return child
}

async function stopServer(child) {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {}
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)])
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {}
}

async function waitForHealthz(baseUrl) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`)
      const body = await response.json()
      if (response.ok && body.status === 'ok') return
    } catch {}
    await delay(200)
  }
  throw new Error('Dev server did not answer /healthz within 30s')
}

function startAuthServer(port) {
  const server = createHttpServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const params = new URLSearchParams(body)
      const socketId = params.get('socket_id') ?? ''
      const channelName = params.get('channel_name') ?? ''
      const user = params.get('user') ?? 'alice'
      const payload = authResponse(socketId, channelName, user)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    })
  })
  return new Promise((resolve) => server.listen(port, HOST, () => resolve(server)))
}

function authResponse(socketId, channelName, user) {
  if (user === 'tampered') {
    return { auth: `${APP_KEY}:${'0'.repeat(64)}` }
  }

  if (channelName.startsWith('presence-')) {
    const channelData = JSON.stringify({ user_id: user, user_info: { name: capitalize(user) } })
    const signature = createHmac('sha256', APP_SECRET)
      .update(`${socketId}:${channelName}:${channelData}`)
      .digest('hex')
    return { auth: `${APP_KEY}:${signature}`, channel_data: channelData }
  }

  const signature = createHmac('sha256', APP_SECRET)
    .update(`${socketId}:${channelName}`)
    .digest('hex')
  return { auth: `${APP_KEY}:${signature}` }
}

function capitalize(value) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}

function stopAuthServer(server) {
  return new Promise((resolve) => server.close(resolve))
}

function createClient(port, authPort, user) {
  return new Pusher(APP_KEY, {
    cluster: 'mt1',
    wsHost: HOST,
    wsPort: port,
    wssPort: port,
    forceTLS: false,
    enabledTransports: ['ws'],
    disableStats: true,
    channelAuthorization: {
      endpoint: `http://${HOST}:${authPort}/auth`,
      transport: 'ajax',
      params: { user },
    },
  })
}

function waitForEvent(binder, event, label, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      binder.unbind(event)
      reject(new Error(`Timed out waiting for ${label}`))
    }, timeoutMs)
    binder.bind(event, (data) => {
      clearTimeout(timer)
      binder.unbind(event)
      resolve(data)
    })
  })
}

async function subscribe(client) {
  const channel = client.subscribe(CHANNEL)
  await waitForEvent(channel, 'pusher:subscription_succeeded', `subscription on ${CHANNEL}`)
  return channel
}

async function checkClientDelivery(server, channelA) {
  const greeting = waitForEvent(channelA, 'greeting', 'greeting event')
  await server.trigger(CHANNEL, 'greeting', { hello: 'world' })
  assert.deepEqual(await greeting, { hello: 'world' })
}

async function checkSocketExclusion(server, clientA, channelA, channelB) {
  let receivedByA = false
  channelA.bind('exclusive', () => {
    receivedByA = true
  })

  const receivedByB = waitForEvent(channelB, 'exclusive', 'exclusive event on B')
  await server.trigger(CHANNEL, 'exclusive', { n: 1 }, { socket_id: clientA.connection.socket_id })
  assert.deepEqual(await receivedByB, { n: 1 })
  await delay(1200)
  assert.equal(receivedByA, false, 'A received an event targeted at its own socket_id')
}

async function checkTamperedSignature(baseUrl) {
  const body = JSON.stringify({ name: 'tamper', channels: [CHANNEL], data: '{}' })
  const timestamp = Math.floor(Date.now() / 1000)
  const query =
    `auth_key=${APP_KEY}&auth_timestamp=${timestamp}` +
    `&auth_version=1.0&body_md5=${createHash('md5').update(body).digest('hex')}`
  const signature = createHmac('sha256', APP_SECRET)
    .update(`POST\n/apps/${APP_ID}/events\n${query}`)
    .digest('hex')

  const send = async (sig) => {
    const response = await fetch(
      `${baseUrl}/apps/${APP_ID}/events?${query}&auth_signature=${sig}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      },
    )
    await response.text()
    return response.status
  }

  assert.equal(await send(signature), 200)
  const firstCharacter = signature.slice(0, 1)
  const tampered = `${firstCharacter === '0' ? '1' : '0'}${signature.slice(1)}`
  assert.equal(await send(tampered), 401)
}

async function checkPingPong(server, channelA) {
  await delay(3000)
  assert.equal(channelA.pusher.connection.state, 'connected')
  const alive = waitForEvent(channelA, 'after-ping', 'event after 3s of activity timeouts')
  await server.trigger(CHANNEL, 'after-ping', { alive: true })
  assert.deepEqual(await alive, { alive: true })
}

async function checkPrivateDelivery(server, channel) {
  const received = waitForEvent(channel, 'private-greeting', 'private event')
  await server.trigger(PRIVATE_CHANNEL, 'private-greeting', { hello: 'private' })
  assert.deepEqual(await received, { hello: 'private' })
}

async function checkTamperedChannelAuth(port, authPort) {
  const client = createClient(port, authPort, 'tampered')
  clients.push(client)

  const connectionError = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for a PusherError with code 4009'))
    }, 10_000)
    client.connection.bind('error', (event) => {
      clearTimeout(timer)
      resolve(event)
    })
  })

  const channel = client.subscribe(PRIVATE_CHANNEL)
  let subscribed = false
  channel.bind('pusher:subscription_succeeded', () => {
    subscribed = true
  })

  const error = await connectionError
  assert.equal(error.type, 'PusherError')
  assert.equal(error.data.code, 4009)
  await delay(300)
  assert.equal(subscribed, false, 'tampered auth reached subscription_succeeded')
}

async function checkPresenceJoin(port, authPort) {
  const bobClient = createClient(port, authPort, 'bob')
  clients.push(bobClient)
  const bobChannel = bobClient.subscribe(PRESENCE_CHANNEL)
  const bobMembers = await waitForEvent(
    bobChannel,
    'pusher:subscription_succeeded',
    'bob presence subscription',
  )
  assert.equal(bobMembers.count, 1)
  assert.equal(bobMembers.get('alice'), null)

  const memberAdded = waitForEvent(bobChannel, 'pusher:member_added', 'alice member_added')

  const aliceClient = createClient(port, authPort, 'alice')
  clients.push(aliceClient)
  const aliceChannel = aliceClient.subscribe(PRESENCE_CHANNEL)
  const aliceMembers = await waitForEvent(
    aliceChannel,
    'pusher:subscription_succeeded',
    'alice presence subscription',
  )
  assert.equal(aliceMembers.count, 2)
  assert.deepEqual(aliceMembers.get('alice'), { id: 'alice', info: { name: 'Alice' } })

  assert.deepEqual(await memberAdded, { id: 'alice', info: { name: 'Alice' } })
  assert.equal(bobChannel.members.count, 2)
  assert.deepEqual(bobChannel.members.get('alice'), { id: 'alice', info: { name: 'Alice' } })

  return { bobChannel, aliceClient, aliceChannel }
}

async function checkPresenceLeave(port, authPort, bobChannel, aliceClient) {
  let added = 0
  bobChannel.bind('pusher:member_added', () => {
    added += 1
  })

  const aliceSecond = createClient(port, authPort, 'alice')
  clients.push(aliceSecond)
  const aliceSecondChannel = aliceSecond.subscribe(PRESENCE_CHANNEL)
  const secondMembers = await waitForEvent(
    aliceSecondChannel,
    'pusher:subscription_succeeded',
    'alice second socket subscription',
  )
  assert.equal(secondMembers.count, 2, 'second socket duplicated the member')
  await delay(300)
  assert.equal(added, 0, 'second socket for alice emitted member_added')
  assert.equal(bobChannel.members.count, 2)

  aliceClient.disconnect()
  await delay(300)
  assert.equal(bobChannel.members.count, 2, 'first socket leaving removed the member')

  const memberRemoved = waitForEvent(bobChannel, 'pusher:member_removed', 'alice member_removed')
  aliceSecond.disconnect()
  assert.deepEqual(await memberRemoved, { id: 'alice', info: { name: 'Alice' } })
  assert.equal(bobChannel.members.count, 1)
  assert.equal(bobChannel.members.get('alice'), null)
}

async function checkChannelIsolation(server, bobChannel, publicChannel, privateChannel) {
  const presenceEvent = waitForEvent(bobChannel, 'presence-greeting', 'presence event')
  await server.trigger(PRESENCE_CHANNEL, 'presence-greeting', { hello: 'presence' })
  assert.deepEqual(await presenceEvent, { hello: 'presence' })

  let leaked = false
  publicChannel.bind('private-only', () => {
    leaked = true
  })

  const privateEvent = waitForEvent(privateChannel, 'private-only', 'private event after tamper')
  await server.trigger(PRIVATE_CHANNEL, 'private-only', { hello: 'private' })
  assert.deepEqual(await privateEvent, { hello: 'private' })
  await delay(300)
  assert.equal(leaked, false, 'public-only client received a private event')
}

const checks = [
  ['pusher-js connects and subscribes to public-smoke', null],
  ['pusher SDK trigger reaches pusher-js', null],
  ['socket_id exclusion skips the targeted socket', null],
  ['tampered auth_signature returns 401', null],
  ['socket survives 3s with a 1s activity timeout', null],
  ['pusher-js subscribes to private-room and receives a triggered event', null],
  ['tampered channel auth never subscribes and reports PusherError 4009', null],
  ['presence join sends member_added and lists the member', null],
  ['presence leave fires member_removed only for the last socket', null],
  ['presence events arrive and private events do not leak', null],
]

const port = Number(process.env.PUSHER_COMPAT_PORT ?? (await findFreePort(DEFAULT_PORT)))
const baseUrl = `http://${HOST}:${port}`
const authPort = await findFreePort(port + 1)
const authUrl = `http://${HOST}:${authPort}/auth`

backupDevVars()
const authServer = await startAuthServer(authPort)
const server = startServer(port)
const clients = []

try {
  await waitForHealthz(baseUrl)
  console.log(`dev server on ${baseUrl}`)
  console.log(`auth server on ${authUrl}`)

  const clientA = createClient(port, authPort, 'alice')
  clients.push(clientA)
  const channelA = await subscribe(clientA)
  checks[0][1] = true
  console.log(`PASS 1 ${checks[0][0]}`)

  const pusherServer = new PusherServer({
    appId: APP_ID,
    key: APP_KEY,
    secret: APP_SECRET,
    host: HOST,
    port: String(port),
    useTLS: false,
  })

  await checkClientDelivery(pusherServer, channelA)
  checks[1][1] = true
  console.log(`PASS 2 ${checks[1][0]}`)

  const clientB = createClient(port, authPort, 'alice')
  clients.push(clientB)
  const channelB = await subscribe(clientB)
  await checkSocketExclusion(pusherServer, clientA, channelA, channelB)
  checks[2][1] = true
  console.log(`PASS 3 ${checks[2][0]}`)

  await checkTamperedSignature(baseUrl)
  checks[3][1] = true
  console.log(`PASS 4 ${checks[3][0]}`)

  await checkPingPong(pusherServer, channelA)
  checks[4][1] = true
  console.log(`PASS 5 ${checks[4][0]}`)

  const privateClient = createClient(port, authPort, 'alice')
  clients.push(privateClient)
  const privateChannel = privateClient.subscribe(PRIVATE_CHANNEL)
  await waitForEvent(privateChannel, 'pusher:subscription_succeeded', 'private subscription')
  await checkPrivateDelivery(pusherServer, privateChannel)
  checks[5][1] = true
  console.log(`PASS 6 ${checks[5][0]}`)

  await checkTamperedChannelAuth(port, authPort)
  await checkPrivateDelivery(pusherServer, privateChannel)
  checks[6][1] = true
  console.log(`PASS 7 ${checks[6][0]}`)

  const presence = await checkPresenceJoin(port, authPort)
  checks[7][1] = true
  console.log(`PASS 8 ${checks[7][0]}`)

  await checkPresenceLeave(port, authPort, presence.bobChannel, presence.aliceClient)
  checks[8][1] = true
  console.log(`PASS 9 ${checks[8][0]}`)

  await checkChannelIsolation(pusherServer, presence.bobChannel, channelA, privateChannel)
  checks[9][1] = true
  console.log(`PASS 10 ${checks[9][0]}`)
} catch (error) {
  for (let index = 0; index < checks.length; index += 1) {
    if (checks[index][1] === null) {
      console.error(`FAIL ${index + 1} ${checks[index][0]}: ${error.message}`)
      break
    }
  }
  if (serverLog.length > 0) console.error(`\n--- dev server output ---\n${serverLog}`)
} finally {
  for (const client of clients) client.disconnect()
  await stopServer(server)
  await stopAuthServer(authServer)
  restoreDevVars()
}

const passed = checks.filter(([, ok]) => ok === true).length
console.log(`${passed}/${checks.length} checks passed`)
if (passed !== checks.length) process.exit(1)
