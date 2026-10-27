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

function waitForEventWithMetadata(binder, event, label, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      binder.unbind(event)
      reject(new Error(`Timed out waiting for ${label}`))
    }, timeoutMs)
    binder.bind(event, (data, metadata) => {
      clearTimeout(timer)
      binder.unbind(event)
      resolve({ data, metadata })
    })
  })
}

function waitForPusherError(client, code, label, timeoutMs = 10_000) {
  const connection = client.connection
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.unbind('error', handler)
      reject(new Error(`Timed out waiting for ${label}`))
    }, timeoutMs)
    const handler = (event) => {
      if (event?.type !== 'PusherError' || event.data?.code !== code) return
      clearTimeout(timer)
      connection.unbind('error', handler)
      resolve(event)
    }
    connection.bind('error', handler)
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

async function checkPrivateClientEvent(port, authPort, senderChannel) {
  const receiverClient = createClient(port, authPort, 'bob')
  clients.push(receiverClient)
  const receiverChannel = receiverClient.subscribe(PRIVATE_CHANNEL)
  await waitForEvent(receiverChannel, 'pusher:subscription_succeeded', 'bob private subscription')

  let senderReceived = false
  senderChannel.bind('client-typing', () => {
    senderReceived = true
  })

  const received = waitForEvent(receiverChannel, 'client-typing', 'client-typing on the receiver')
  senderChannel.trigger('client-typing', { typing: true })
  assert.deepEqual(await received, { typing: true })
  await delay(300)
  assert.equal(senderReceived, false, 'the sender received its own client event')
  return receiverChannel
}

async function checkPresenceClientEvent(port, authPort, senderChannel, senderUserId) {
  const receiverClient = createClient(port, authPort, 'carol')
  clients.push(receiverClient)
  const receiverChannel = receiverClient.subscribe(PRESENCE_CHANNEL)
  await waitForEvent(
    receiverChannel,
    'pusher:subscription_succeeded',
    'carol presence subscription',
  )

  const received = waitForEventWithMetadata(
    receiverChannel,
    'client-typing',
    'presence client event',
  )
  senderChannel.trigger('client-typing', { typing: true })

  const { data, metadata } = await received
  assert.deepEqual(data, { typing: true })
  assert.equal(metadata.user_id, senderUserId)
  return receiverChannel
}

async function checkPublicClientEventRejected(senderChannel, otherChannel) {
  let delivered = false
  otherChannel.bind('client-nope', () => {
    delivered = true
  })

  const error = waitForPusherError(senderChannel.pusher, 4300, 'a 4300 rejection')
  senderChannel.trigger('client-nope', { n: 1 })

  const event = await error
  assert.equal(event.type, 'PusherError')
  assert.equal(event.data.code, 4300)
  await delay(300)
  assert.equal(delivered, false, 'a public channel client event was delivered')
  assert.equal(senderChannel.pusher.connection.state, 'connected')
}

async function checkClientEventRateLimit(port, authPort, receiverChannel) {
  const senderClient = createClient(port, authPort, 'alice')
  clients.push(senderClient)
  const senderChannel = senderClient.subscribe(PRIVATE_CHANNEL)
  await waitForEvent(senderChannel, 'pusher:subscription_succeeded', 'burst client subscription')

  let errors = 0
  const onError = (event) => {
    if (event?.type === 'PusherError' && event.data?.code === 4301) errors += 1
  }
  senderClient.connection.bind('error', onError)

  let delivered = 0
  receiverChannel.bind('client-burst', () => {
    delivered += 1
  })

  for (let index = 0; index < 11; index += 1) senderChannel.trigger('client-burst', { index })

  await delay(600)
  assert.equal(errors, 1, `expected exactly one 4301 error, saw ${errors}`)
  assert.equal(delivered, 10, `expected ten delivered client events, saw ${delivered}`)
  assert.equal(senderClient.connection.state, 'connected')

  await delay(1100)
  const fresh = waitForEvent(receiverChannel, 'client-burst', 'a client event after the window')
  senderChannel.trigger('client-burst', { index: 'fresh' })
  assert.deepEqual(await fresh, { index: 'fresh' })
  assert.equal(errors, 1, 'a client event after the window was rate limited')
  senderClient.connection.unbind('error', onError)
}

async function checkBatchPublish(server, privateChannel, publicChannel) {
  const privateEvent = waitForEvent(privateChannel, 'batch-private', 'the private batch event')
  const publicEvent = waitForEvent(publicChannel, 'batch-public', 'the public batch event')

  const response = await server.triggerBatch([
    { channel: PRIVATE_CHANNEL, name: 'batch-private', data: { n: 1 } },
    { channel: CHANNEL, name: 'batch-public', data: { n: 2 } },
  ])

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {})
  assert.deepEqual(await privateEvent, { n: 1 })
  assert.deepEqual(await publicEvent, { n: 2 })
}

async function checkChannelList(server) {
  const response = await server.get({
    path: '/channels',
    params: { filter_by_prefix: 'presence-', info: 'user_count' },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    channels: { [PRESENCE_CHANNEL]: { user_count: 2 } },
  })
}

async function checkChannelQueries(server, privateSubscriptions) {
  const privateResponse = await server.get({
    path: `/channels/${PRIVATE_CHANNEL}`,
    params: { info: 'subscription_count' },
  })
  assert.equal(privateResponse.status, 200)
  assert.deepEqual(await privateResponse.json(), {
    occupied: true,
    subscription_count: privateSubscriptions,
  })

  const presenceResponse = await server.get({
    path: `/channels/${PRESENCE_CHANNEL}`,
    params: { info: 'user_count' },
  })
  assert.equal(presenceResponse.status, 200)
  assert.deepEqual(await presenceResponse.json(), { occupied: true, user_count: 2 })

  const usersResponse = await server.get({ path: `/channels/${PRESENCE_CHANNEL}/users` })
  assert.equal(usersResponse.status, 200)
  assert.deepEqual(await usersResponse.json(), { users: [{ id: 'bob' }, { id: 'carol' }] })
}

async function checkChannelInfoRejection(server) {
  await assert.rejects(
    () => server.get({ path: `/channels/${CHANNEL}`, params: { info: 'user_count' } }),
    (error) => {
      assert.equal(error.status, 400)
      return true
    },
  )
}

function parseJson(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function openRawSocket(path) {
  const ws = new WebSocket(`ws://${HOST}:${port}${path}`)
  const frames = []
  let cursor = 0
  let close = null

  ws.addEventListener('error', () => {})
  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') frames.push(event.data)
  })
  ws.addEventListener('close', (event) => {
    close = { code: event.code, reason: event.reason }
  })

  const isPusherError = (code) => (frame) =>
    frame.event === 'pusher:error' && frame.data?.code === code
  const isEvent = (name) => (frame) => frame.event === name

  async function waitFor(predicate, label, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      while (cursor < frames.length) {
        const frame = parseJson(frames[cursor])
        cursor += 1
        if (frame !== null && predicate(frame)) return frame
      }
      if (close !== null) throw new Error(`${label}: socket closed with ${close.code}`)
      if (Date.now() > deadline) throw new Error(`${label}: timed out`)
      await delay(20)
    }
  }

  async function waitForClose(label, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    while (close === null) {
      if (Date.now() > deadline) throw new Error(`${label}: timed out waiting for close`)
      await delay(20)
    }
    return close
  }

  return {
    rawFrames: frames,
    send: (payload) => ws.send(payload),
    close: () => {
      try {
        ws.close(1000, 'done')
      } catch {}
    },
    waitFor,
    waitForClose,
    isPusherError,
    isEvent,
  }
}

async function openConnectedSocket() {
  const socket = openRawSocket(`/app/${APP_KEY}?protocol=7`)
  await socket.waitFor(socket.isEvent('pusher:connection_established'), 'connection_established')
  return socket
}

async function checkHandshakeRejection(path, code, label) {
  const socket = openRawSocket(path)
  try {
    const close = await socket.waitForClose(label)
    assert.equal(close.code, code, `${label}: close code`)

    const error = socket.rawFrames
      .map(parseJson)
      .find(
        (frame) => frame !== null && frame.event === 'pusher:error' && frame.data?.code === code,
      )
    if (socket.rawFrames.length > 0) {
      assert.ok(error, `${label}: frames arrived without a ${code} pusher:error`)
    }
    return error !== undefined
  } finally {
    socket.close()
  }
}

function deliveryNote(delivered) {
  return delivered ? ' (pusher:error then close)' : ' (close only: the frame did not arrive)'
}

async function checkBadFrameRecovery() {
  const socket = await openConnectedSocket()
  try {
    socket.send('not json')
    await socket.waitFor(socket.isPusherError(4300), '4300 for a non-JSON frame')
    socket.send(JSON.stringify({ event: 'pusher:ping', data: {} }))
    await socket.waitFor(socket.isEvent('pusher:pong'), 'pong after a bad frame')
    socket.close()
    await socket.waitForClose('close after a bad frame')
  } finally {
    socket.close()
  }
}

async function checkEncryptedSubscribe() {
  const socket = await openConnectedSocket()
  try {
    socket.send(
      JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'private-encrypted-x' } }),
    )
    await socket.waitFor(socket.isPusherError(4009), '4009 for an encrypted channel')
    const close = await socket.waitForClose('encrypted subscribe close')
    assert.equal(close.code, 4009)
  } finally {
    socket.close()
  }
}

async function checkChannelNameRejection() {
  const socket = await openConnectedSocket()
  try {
    socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'a'.repeat(201) } }))
    await socket.waitFor(socket.isPusherError(4300), '4300 for a 201-character channel')
    socket.send(JSON.stringify({ event: 'pusher:ping', data: {} }))
    await socket.waitFor(socket.isEvent('pusher:pong'), 'pong after a bad channel name')
    socket.close()
    await socket.waitForClose('close after a bad channel name')
  } finally {
    socket.close()
  }
}

async function checkFrameCeiling() {
  const socket = await openConnectedSocket()
  try {
    const oversized = JSON.stringify({
      event: 'pusher:ping',
      data: {},
      pad: 'x'.repeat(70 * 1024),
    })
    assert.ok(Buffer.byteLength(oversized) > 64 * 1024, 'the test frame is not over 64 KiB')

    socket.send(oversized)
    const error = await socket.waitFor(socket.isPusherError(4300), '4300 for a 70 KiB frame')
    assert.match(error.data.message, /64KB/)

    socket.send(JSON.stringify({ event: 'pusher:ping', data: {} }))
    await socket.waitFor(socket.isEvent('pusher:pong'), 'pong after an oversized frame')
    socket.close()
    await socket.waitForClose('close after an oversized frame')
  } finally {
    socket.close()
  }
}

async function checkBodyCeiling(baseUrl) {
  const response = await fetch(`${baseUrl}/apps/${APP_ID}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(300 * 1024),
  })
  const text = await response.text()
  assert.equal(response.status, 413, `300 KiB body: expected 413, got ${response.status}: ${text}`)
}

async function signedPublish(baseUrl, body) {
  const timestamp = Math.floor(Date.now() / 1000)
  const params = new URLSearchParams({
    auth_key: APP_KEY,
    auth_timestamp: String(timestamp),
    auth_version: '1.0',
    body_md5: createHash('md5').update(body).digest('hex'),
  })
  const signature = createHmac('sha256', APP_SECRET)
    .update(`POST\n/apps/${APP_ID}/events\n${params}`)
    .digest('hex')
  params.set('auth_signature', signature)

  return fetch(`${baseUrl}/apps/${APP_ID}/events?${params}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

async function checkEncryptedPublish(baseUrl) {
  const body = JSON.stringify({
    name: 'encrypted-nope',
    channels: ['private-encrypted-room'],
    data: '{}',
  })
  const response = await signedPublish(baseUrl, body)
  const payload = await response.json()
  assert.equal(response.status, 400, `expected 400, got ${response.status}`)
  assert.match(String(payload.error), /Encrypted/)
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
  ['a private client event reaches the other subscriber and not the sender', null],
  ['a presence client event carries the sender user_id as metadata', null],
  ['a public channel client event is rejected with 4300 and not delivered', null],
  ['eleven rapid client events yield one 4301 and the socket keeps working', null],
  ['triggerBatch delivers a private and a public event and returns 200', null],
  ['GET /channels lists the occupied presence channel with user_count', null],
  ['GET /channels/<name> and /users report occupancy, counts, and ids', null],
  ['GET /channels/<public>?info=user_count rejects with 400', null],
  ['a wrong key reports 4001 and closes with 4001', null],
  ['protocol=6 reports 4007 and closes with 4007', null],
  ['a missing protocol reports 4008 and closes with 4008', null],
  ['a WebSocket upgrade to /nope reports 4005 and closes with 4005', null],
  ['a non-JSON frame gets 4300 and the socket still answers ping', null],
  ['an encrypted subscribe gets 4009 and closes with 4009', null],
  ['a 201-character channel gets 4300 and the socket stays usable', null],
  ['a 70 KiB text frame gets 4300 and the socket stays usable', null],
  ['an unauthenticated 300 KiB publish returns 413', null],
  ['a signed publish to an encrypted channel returns 400', null],
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

  const privateReceiver = await checkPrivateClientEvent(port, authPort, privateChannel)
  checks[10][1] = true
  console.log(`PASS 11 ${checks[10][0]}`)

  await checkPresenceClientEvent(port, authPort, presence.bobChannel, 'bob')
  checks[11][1] = true
  console.log(`PASS 12 ${checks[11][0]}`)

  await checkPublicClientEventRejected(channelA, channelB)
  checks[12][1] = true
  console.log(`PASS 13 ${checks[12][0]}`)

  await checkClientEventRateLimit(port, authPort, privateReceiver)
  checks[13][1] = true
  console.log(`PASS 14 ${checks[13][0]}`)

  await checkBatchPublish(pusherServer, privateChannel, channelA)
  checks[14][1] = true
  console.log(`PASS 15 ${checks[14][0]}`)

  await checkChannelList(pusherServer)
  checks[15][1] = true
  console.log(`PASS 16 ${checks[15][0]}`)

  await checkChannelQueries(pusherServer, 3)
  checks[16][1] = true
  console.log(`PASS 17 ${checks[16][0]}`)

  await checkChannelInfoRejection(pusherServer)
  checks[17][1] = true
  console.log(`PASS 18 ${checks[17][0]}`)

  const wrongKey = await checkHandshakeRejection(`/app/wrong?protocol=7`, 4001, 'wrong key')
  checks[18][1] = true
  console.log(`PASS 19 ${checks[18][0]}${deliveryNote(wrongKey)}`)

  const oldProtocol = await checkHandshakeRejection(
    `/app/${APP_KEY}?protocol=6`,
    4007,
    'protocol 6',
  )
  checks[19][1] = true
  console.log(`PASS 20 ${checks[19][0]}${deliveryNote(oldProtocol)}`)

  const noProtocol = await checkHandshakeRejection(`/app/${APP_KEY}`, 4008, 'missing protocol')
  checks[20][1] = true
  console.log(`PASS 21 ${checks[20][0]}${deliveryNote(noProtocol)}`)

  const missingPath = await checkHandshakeRejection('/nope', 4005, 'unknown path')
  checks[21][1] = true
  console.log(`PASS 22 ${checks[21][0]}${deliveryNote(missingPath)}`)

  await checkBadFrameRecovery()
  checks[22][1] = true
  console.log(`PASS 23 ${checks[22][0]}`)

  await checkEncryptedSubscribe()
  checks[23][1] = true
  console.log(`PASS 24 ${checks[23][0]}`)

  await checkChannelNameRejection()
  checks[24][1] = true
  console.log(`PASS 25 ${checks[24][0]}`)

  await checkFrameCeiling()
  checks[25][1] = true
  console.log(`PASS 26 ${checks[25][0]}`)

  await checkBodyCeiling(baseUrl)
  checks[26][1] = true
  console.log(`PASS 27 ${checks[26][0]}`)

  await checkEncryptedPublish(baseUrl)
  checks[27][1] = true
  console.log(`PASS 28 ${checks[27][0]}`)
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
