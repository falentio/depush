import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import PusherServer from 'pusher'
import Pusher from 'pusher-js'

const HOST = '127.0.0.1'
const PORT = Number(process.env.PUSHER_COMPAT_PORT ?? 8787)
const BASE_URL = `http://${HOST}:${PORT}`
const APP_ID = '1'
const APP_KEY = 'test-key'
const APP_SECRET = 'test-secret'
const CHANNEL = 'public-smoke'
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

function startServer() {
  const child = spawn(
    'pnpm',
    ['exec', 'vite', '--host', HOST, '--port', String(PORT), '--strictPort'],
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

async function waitForHealthz() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/healthz`)
      const body = await response.json()
      if (response.ok && body.status === 'ok') return
    } catch {}
    await delay(200)
  }
  throw new Error('Dev server did not answer /healthz within 30s')
}

function createClient() {
  return new Pusher(APP_KEY, {
    cluster: 'mt1',
    wsHost: HOST,
    wsPort: PORT,
    wssPort: PORT,
    forceTLS: false,
    enabledTransports: ['ws'],
    disableStats: true,
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

async function checkTamperedSignature() {
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
      `${BASE_URL}/apps/${APP_ID}/events?${query}&auth_signature=${sig}`,
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

const checks = [
  ['pusher-js connects and subscribes to public-smoke', null],
  ['pusher SDK trigger reaches pusher-js', null],
  ['socket_id exclusion skips the targeted socket', null],
  ['tampered auth_signature returns 401', null],
  ['socket survives 3s with a 1s activity timeout', null],
]

backupDevVars()
const server = startServer()
const clients = []

try {
  await waitForHealthz()

  const clientA = createClient()
  clients.push(clientA)
  const channelA = await subscribe(clientA)
  checks[0][1] = true
  console.log(`PASS 1 ${checks[0][0]}`)

  const pusherServer = new PusherServer({
    appId: APP_ID,
    key: APP_KEY,
    secret: APP_SECRET,
    host: HOST,
    port: String(PORT),
    useTLS: false,
  })

  await checkClientDelivery(pusherServer, channelA)
  checks[1][1] = true
  console.log(`PASS 2 ${checks[1][0]}`)

  const clientB = createClient()
  clients.push(clientB)
  const channelB = await subscribe(clientB)
  await checkSocketExclusion(pusherServer, clientA, channelA, channelB)
  checks[2][1] = true
  console.log(`PASS 3 ${checks[2][0]}`)

  await checkTamperedSignature()
  checks[3][1] = true
  console.log(`PASS 4 ${checks[3][0]}`)

  await checkPingPong(pusherServer, channelA)
  checks[4][1] = true
  console.log(`PASS 5 ${checks[4][0]}`)
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
  restoreDevVars()
}

const passed = checks.filter(([, ok]) => ok === true).length
console.log(`${passed}/${checks.length} checks passed`)
if (passed !== checks.length) process.exit(1)
