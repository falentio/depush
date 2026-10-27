import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import Pusher from 'pusher'
import { bootstrap, DEV_VARS_CONTENT } from './bootstrap.mjs'

const HOST = '127.0.0.1'
const DEFAULT_PORT = 8793
const DEV_VARS = '.dev.vars'
const DEV_VARS_BACKUP = '.dev.vars.fuzz-backup'

let APP_ID = ''
let APP_KEY = ''
let APP_SECRET = ''
const DEFAULT_ITERATIONS = 200
const HTTP_TIMEOUT_MS = 5_000
const WS_TIMEOUT_MS = 3_000
const HEALTH_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 5_000
const LOG_LIMIT = 8_000
const MAX_BODY_BYTES = 256 * 1024
const MAX_DATA_BYTES = 10 * 1024
const ALLOWED_CLOSE_CODES = new Set([1000, 4001, 4005, 4007, 4008, 4009])
const CHANNEL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-=@,.;'
const INFO_VALUES = [
  '',
  'user_count',
  'subscription_count',
  'cache',
  'user_count,subscription_count',
  'cache,user_count',
  'bogus',
  ',',
  'user_count,',
  'user_count,,subscription_count',
  'x'.repeat(300),
]
const PREFIX_VALUES = [
  '',
  'presence-',
  'private-',
  'cache-',
  'public-',
  'presence-cache-',
  'bogus',
  'has space',
  'x'.repeat(201),
]
const LIMIT_VALUES = [
  '',
  '1',
  '2',
  '50',
  '100',
  '0',
  '101',
  '-1',
  'abc',
  '1e9',
  '999999999999999999999',
  ' 5',
  '5.5',
]
const BEFORE_VALUES = ['', '1', '9223372036854775807', '0', '-1', 'abc', '999999999999999999999999']
const PING_PAYLOAD = JSON.stringify({ event: 'pusher:ping' })
const MAX_DETAIL = 500

const STOPPED = Symbol('fuzz stopped')

let server = null
let serverLog = ''
let devVarsManaged = false
let cleanupPromise = null
let stopping = false
let stopSignal = null

class FuzzTimeout extends Error {
  constructor(message) {
    super(message)
    this.name = 'FuzzTimeout'
  }
}

class SocketClosed extends Error {
  constructor(info) {
    super(`socket closed with ${info.code}`)
    this.name = 'SocketClosed'
    this.info = info
  }
}

class FindingReporter {
  constructor(seed, iterations) {
    this.seed = seed
    this.iterations = iterations
    this.httpCount = 0
    this.wsCount = 0
    this.httpStatuses = new Map()
    this.wsOutcomes = new Map()
  }

  start() {
    console.log(`fuzz seed ${this.seed} (reproduce with FUZZ_SEED=${this.seed})`)
    console.log(`iterations ${this.iterations}, local server only`)
  }

  countHttp(status) {
    this.httpCount += 1
    this.httpStatuses.set(status, (this.httpStatuses.get(status) ?? 0) + 1)
  }

  countWs(outcome) {
    this.wsCount += 1
    this.wsOutcomes.set(outcome, (this.wsOutcomes.get(outcome) ?? 0) + 1)
  }

  report(finding) {
    const log = serverLog.trim()
    console.error('')
    console.error('FUZZ FINDING')
    console.error(`seed: ${this.seed}`)
    console.error(`iteration: ${finding.iteration}`)
    console.error(`surface: ${finding.surface}`)
    console.error('input:')
    console.error(truncate(finding.input, 4_000))
    console.error(`observed: ${finding.observed}`)
    if (finding.body !== undefined && finding.body !== '') {
      console.error(`body: ${truncate(finding.body, MAX_DETAIL)}`)
    }
    console.error('server log tail:')
    console.error(log === '' ? '(empty)' : truncate(log.slice(-4_000), 4_000))
    console.error('')
    console.error(`reproduce: FUZZ_SEED=${this.seed} FUZZ_ITERATIONS=${this.iterations} pnpm fuzz`)
  }

  summary() {
    const cases = this.httpCount + this.wsCount
    const statuses = sortedCounts(this.httpStatuses)
    const outcomes = sortedCounts(this.wsOutcomes)
    console.log(
      `fuzz complete: seed ${this.seed}, ${cases} cases (${this.httpCount} http, ${this.wsCount} websocket), 0 findings`,
    )
    console.log(`http statuses: ${statuses === '' ? 'none' : statuses}`)
    console.log(`websocket outcomes: ${outcomes === '' ? 'none' : outcomes}`)
  }
}

function createPrng(seed) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000
  }

  return {
    seed,
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1))
    },
    bool(probability = 0.5) {
      return next() < probability
    },
    pick(items) {
      return items[Math.floor(next() * items.length)]
    },
  }
}

function truncate(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}... (${text.length} characters)`
}

function sortedCounts(counts) {
  return [...counts.entries()]
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([key, count]) => `${key} x${count}`)
    .join(', ')
}

function readSeed() {
  const raw = process.env.FUZZ_SEED
  if (raw === undefined || raw === '') {
    return randomBytes(4).readUInt32BE(0)
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error('FUZZ_SEED must be an unsigned 32-bit integer')
  }
  const seed = Number(raw)
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error('FUZZ_SEED must be an unsigned 32-bit integer')
  }
  return seed
}

function readIterations() {
  const raw = process.env.FUZZ_ITERATIONS
  if (raw === undefined || raw === '') return DEFAULT_ITERATIONS
  if (!/^\d+$/.test(raw)) {
    throw new Error('FUZZ_ITERATIONS must be a positive integer')
  }
  const iterations = Number(raw)
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error('FUZZ_ITERATIONS must be a positive integer')
  }
  return iterations
}

function readPort() {
  const raw = process.env.PUSHER_FUZZ_PORT
  if (raw === undefined || raw === '') return null
  if (!/^\d+$/.test(raw)) {
    throw new Error('PUSHER_FUZZ_PORT must be an integer from 1 to 65535')
  }
  const port = Number(raw)
  if (port < 1 || port > 65_535) {
    throw new Error('PUSHER_FUZZ_PORT must be an integer from 1 to 65535')
  }
  return port
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, HOST)
  })
}

async function findFreePort(start) {
  for (let port = start; port < start + 20; port += 1) {
    if (await isPortFree(port)) return port
  }
  throw new Error(`no free port between ${start} and ${start + 19}`)
}

function withoutLocalAppEnv(source) {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => !key.startsWith('PUSHER_') && !key.startsWith('DEPUSH_'),
    ),
  )
}

function backupDevVars() {
  if (existsSync(DEV_VARS_BACKUP)) {
    if (existsSync(DEV_VARS)) unlinkSync(DEV_VARS)
    renameSync(DEV_VARS_BACKUP, DEV_VARS)
  }
  if (existsSync(DEV_VARS)) renameSync(DEV_VARS, DEV_VARS_BACKUP)
  devVarsManaged = true
  writeFileSync(DEV_VARS, DEV_VARS_CONTENT())
}

function restoreDevVars() {
  if (!devVarsManaged) return
  devVarsManaged = false
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
    {
      detached: true,
      env: withoutLocalAppEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const collect = (chunk) => {
    serverLog = `${serverLog}${chunk}`.slice(-LOG_LIMIT)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  return child
}

function waitForExit(child) {
  if (hasExited(child)) return Promise.resolve()
  return new Promise((resolve) => {
    child.once('exit', () => resolve())
  })
}

async function stopChild(child) {
  if (child === null || child.pid === undefined || hasExited(child)) return
  const send = (signal) => {
    try {
      process.kill(-child.pid, signal)
    } catch {}
  }
  send('SIGTERM')
  await Promise.race([waitForExit(child), delay(STOP_TIMEOUT_MS)])
  if (!hasExited(child)) {
    send('SIGKILL')
    await waitForExit(child)
  }
}

async function doCleanup() {
  try {
    await stopChild(server)
  } finally {
    restoreDevVars()
  }
}

function cleanup() {
  if (cleanupPromise === null) cleanupPromise = doCleanup()
  return cleanupPromise
}

function isHealthy(body) {
  return typeof body === 'object' && body !== null && 'status' in body && body.status === 'ok'
}

async function fetchHealth(baseUrl) {
  const response = await fetch(`${baseUrl}/healthz`, {
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { ok: response.ok && isHealthy(body), status: response.status, body }
}

async function waitForHealthz(baseUrl) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (server !== null && hasExited(server)) {
      throw new Error('local dev server exited before /healthz answered')
    }
    try {
      const health = await fetchHealth(baseUrl)
      if (health.ok) return
    } catch {}
    await delay(200)
  }
  throw new Error(`local dev server did not answer /healthz within 30s`)
}

async function checkHealth(baseUrl, label, iteration) {
  try {
    const health = await fetchHealth(baseUrl)
    if (health.ok) return null
    return {
      iteration,
      surface: 'health',
      input: `GET ${baseUrl}/healthz (${label})`,
      observed: `status ${health.status}`,
      body: typeof health.body === 'string' ? health.body : JSON.stringify(health.body),
    }
  } catch (error) {
    return {
      iteration,
      surface: 'health',
      input: `GET ${baseUrl}/healthz (${label})`,
      observed: `request failed: ${describeError(error)}`,
      body: '',
    }
  }
}

function describeError(error) {
  if (error instanceof FuzzTimeout) return error.message
  if (error instanceof Error) {
    const cause = error.cause ?? error.error
    if (cause !== undefined && cause !== null && typeof cause === 'object') {
      const code = 'code' in cause ? String(cause.code) : ''
      const message = 'message' in cause ? String(cause.message) : ''
      return `${error.name}: ${error.message} (${code === '' ? message : code})`
    }
    return `${error.name}: ${error.message}`
  }
  return String(error)
}

function createPusherFor(port) {
  const instances = new Map()
  return (appId) => {
    let instance = instances.get(appId)
    if (instance === undefined) {
      instance = new Pusher({
        appId,
        key: APP_KEY,
        secret: APP_SECRET,
        host: HOST,
        port,
        useTLS: false,
        timeout: HTTP_TIMEOUT_MS,
      })
      instances.set(appId, instance)
    }
    return instance
  }
}

function randomToken(prng, length) {
  let token = ''
  for (let index = 0; index < length; index += 1) {
    token += CHANNEL_ALPHABET[prng.int(0, CHANNEL_ALPHABET.length - 1)]
  }
  return token
}

function validChannel(prng) {
  const prefix = prng.pick([
    'public-',
    'private-',
    'presence-',
    'private-cache-',
    'presence-cache-',
    'cache-',
    'private-encrypted-',
    '',
  ])
  return `${prefix}${randomToken(prng, prng.int(1, 12))}`
}

function invalidChannel(prng) {
  return prng.pick([
    '',
    'has space',
    'has:colon',
    'a/b',
    'a?b',
    'a#b',
    'umlaut-\u00fc',
    'x'.repeat(201),
    '%',
  ])
}

function randomHttpChannel(prng) {
  return prng.bool(0.65) ? validChannel(prng) : invalidChannel(prng)
}

function sdkChannel(prng) {
  if (prng.bool(0.7)) return validChannel(prng)
  return prng.pick(['has:colon', 'x'.repeat(201), '', 'a/b'])
}

function randomQueryParams(prng) {
  const params = {}
  if (prng.bool(0.45)) params.info = prng.pick(INFO_VALUES)
  if (prng.bool(0.35)) params.filter_by_prefix = prng.pick(PREFIX_VALUES)
  if (prng.bool(0.35)) params.limit = prng.pick(LIMIT_VALUES)
  if (prng.bool(0.25)) params.before = prng.pick(BEFORE_VALUES)
  if (prng.bool(0.1)) params.extra = randomToken(prng, 8)
  return params
}

function randomRawParams(prng) {
  const pairs = []
  if (prng.bool(0.4)) pairs.push(['info', prng.pick(INFO_VALUES)])
  if (prng.bool(0.35)) pairs.push(['filter_by_prefix', prng.pick(PREFIX_VALUES)])
  if (prng.bool(0.35)) pairs.push(['limit', prng.pick(LIMIT_VALUES)])
  if (prng.bool(0.25)) pairs.push(['before', prng.pick(BEFORE_VALUES)])
  if (prng.bool(0.1)) pairs.push([`x-${randomToken(prng, 4)}`, randomToken(prng, 8)])
  if (prng.bool(0.05)) pairs.push(['info', prng.pick(INFO_VALUES)])
  if (prng.bool(0.15)) pairs.push(['protocol', prng.pick(['7', '6', 'abc'])])
  return pairs
}

function randomJsonValue(prng, depth = 0) {
  const choice = depth > 2 ? prng.int(0, 3) : prng.int(0, 6)
  switch (choice) {
    case 0:
      return null
    case 1:
      return prng.bool()
    case 2:
      return prng.int(-1_000, 1_000)
    case 3:
      return randomToken(prng, prng.int(0, 30))
    case 4:
      return Array.from({ length: prng.int(0, 4) }, () => randomJsonValue(prng, depth + 1))
    case 5:
      return Object.fromEntries(
        Array.from({ length: prng.int(0, 4) }, () => [
          prng.pick(['a', 'b', 'event', 'data', 'channel', 'info', 'x y', '']),
          randomJsonValue(prng, depth + 1),
        ]),
      )
    default:
      return String(prng.next())
  }
}

function randomTextBody(prng) {
  return prng.pick([
    '{',
    '{"event":',
    'not json',
    'null',
    '"just a string"',
    '[]',
    '\u0000\u0001\uffff',
    randomToken(prng, prng.int(1, 40)),
    JSON.stringify({ event: 'x', data: randomToken(prng, 10) }),
  ])
}

function triggerValue(prng, channel) {
  const value = {
    name: prng.pick(['fuzz-event', 'client-test', 'x'.repeat(prng.int(1, 200))]),
    data: prng.pick([
      randomToken(prng, prng.int(0, 64)),
      JSON.stringify({ fuzz: prng.int(0, 1_000), text: randomToken(prng, 8) }),
    ]),
  }
  if (prng.bool(0.3)) {
    value.socket_id = `${prng.int(0, 999)}.${prng.int(0, 999)}`
  }
  if (prng.bool(0.6)) {
    value.channels = Array.from({ length: prng.int(1, 3) }, (_, index) =>
      index === 0 ? channel : validChannel(prng),
    )
  } else {
    value.channel = channel
  }
  return value
}

function batchValue(prng, channel, count) {
  return {
    batch: Array.from({ length: count }, () => ({
      name: prng.pick(['fuzz-event', 'batch-item']),
      channel: prng.bool(0.7) ? channel : validChannel(prng),
      data: randomToken(prng, prng.int(0, 64)),
    })),
  }
}

function weirdTriggerValue(prng, channel) {
  return prng.pick([
    { name: '', channel, data: 'x' },
    { name: 'x'.repeat(201), channel, data: 'x' },
    { name: 'x', channel, data: { nested: true } },
    { name: 'x', channel, data: 'x', info: 'wat' },
    { name: 'x', channel: `private-encrypted-${randomToken(prng, 6)}`, data: 'x' },
    { name: 'x', channel: `presence-${randomToken(prng, 6)}`, data: 'x', socket_id: 'bad' },
    { name: 'x', channels: [], data: 'x' },
  ])
}

function createHttpBody(prng, channel, preferred = null) {
  const kind = prng.pick([
    'empty',
    'malformed',
    'random',
    'trigger',
    'trigger',
    'batch',
    'oversized-data',
    'too-many-channels',
    'too-many-batch',
    'oversized-body',
    'weird-trigger',
  ])
  const chosen = preferred !== null && prng.bool(0.65) ? preferred : kind
  switch (chosen) {
    case 'empty':
      return { label: 'empty body', raw: '', value: undefined }
    case 'malformed': {
      const raw = randomTextBody(prng)
      return { label: `malformed text ${JSON.stringify(raw)}`, raw, value: raw }
    }
    case 'random': {
      const drawn = randomJsonValue(prng)
      const value =
        drawn === null || drawn === false || drawn === 0 || drawn === '' ? { drawn } : drawn
      const raw = JSON.stringify(value)
      return { label: `random JSON ${truncate(raw, 200)}`, raw, value }
    }
    case 'trigger': {
      const value = triggerValue(prng, channel)
      const raw = JSON.stringify(value)
      return { label: `trigger ${truncate(raw, 200)}`, raw, value }
    }
    case 'batch': {
      const value = batchValue(prng, channel, prng.int(1, 3))
      const raw = JSON.stringify(value)
      return { label: `batch ${truncate(raw, 200)}`, raw, value }
    }
    case 'oversized-data': {
      const data = randomToken(prng, MAX_DATA_BYTES + prng.int(1, 5_000))
      const value = { name: 'fuzz-oversized', channel, data }
      return { label: `trigger with ${data.length}-byte data`, raw: JSON.stringify(value), value }
    }
    case 'too-many-channels': {
      const channels = Array.from({ length: 101 + prng.int(0, 5) }, () => validChannel(prng))
      const value = { name: 'fuzz-many', channels, data: 'x' }
      return {
        label: `trigger with ${channels.length} channels`,
        raw: JSON.stringify(value),
        value,
      }
    }
    case 'too-many-batch': {
      const value = batchValue(prng, channel, 11 + prng.int(0, 3))
      return {
        label: `batch with ${value.batch.length} events`,
        raw: JSON.stringify(value),
        value,
      }
    }
    case 'oversized-body': {
      const value = {
        name: 'fuzz-huge',
        channel,
        data: randomToken(prng, MAX_BODY_BYTES + prng.int(1, 1_000)),
      }
      const raw = JSON.stringify(value)
      return { label: `body of ${raw.length} bytes`, raw, value }
    }
    default: {
      const value = weirdTriggerValue(prng, channel)
      const raw = JSON.stringify(value)
      return { label: `invalid trigger ${truncate(raw, 200)}`, raw, value }
    }
  }
}

function sdkPath(prng, channel) {
  switch (prng.pick(['events', 'batch', 'channels', 'channel', 'users', 'history', 'presence'])) {
    case 'events':
      return '/events'
    case 'batch':
      return '/batch_events'
    case 'channels':
      return '/channels'
    case 'channel':
      return `/channels/${channel}`
    case 'users':
      return `/channels/${channel}/users`
    case 'history':
      return `/channels/${channel}/history`
    default:
      return `/channels/${channel}/presence`
  }
}

function sdkReadPath(prng, channel) {
  switch (prng.pick(['channels', 'channel', 'users', 'history', 'presence'])) {
    case 'channels':
      return '/channels'
    case 'channel':
      return `/channels/${channel}`
    case 'users':
      return `/channels/${channel}/users`
    case 'history':
      return `/channels/${channel}/history`
    default:
      return `/channels/${channel}/presence`
  }
}

function rawPath(prng) {
  const appId = prng.pick(['1', '1', '1', '1', '2', '01', '', '1.0', '999'])
  const channel = encodeURIComponent(randomHttpChannel(prng))
  switch (
    prng.pick([
      'events',
      'events',
      'batch',
      'channels',
      'channel',
      'users',
      'history',
      'presence',
      'healthz',
      'apps',
      'apps-root',
      'apps-unknown',
      'app-key',
      'unknown',
    ])
  ) {
    case 'events':
      return `/apps/${appId}/events`
    case 'batch':
      return `/apps/${appId}/batch_events`
    case 'channels':
      return `/apps/${appId}/channels`
    case 'channel':
      return `/apps/${appId}/channels/${channel}`
    case 'users':
      return `/apps/${appId}/channels/${channel}/users`
    case 'history':
      return `/apps/${appId}/channels/${channel}/history`
    case 'presence':
      return `/apps/${appId}/channels/${channel}/presence`
    case 'healthz':
      return '/healthz'
    case 'apps':
      return '/apps'
    case 'apps-root':
      return `/apps/${appId}`
    case 'apps-unknown':
      return `/apps/${appId}/${prng.pick(['nope', 'events/extra', 'channels/x/y/z', 'batch_event'])}`
    case 'app-key':
      return `/app/${prng.pick([APP_KEY, 'wrong-key', encodeURIComponent('bad key')])}`
    default:
      return `/${prng.pick(['nope', 'v1/apps', 'health', 'favicon.ico'])}`
  }
}

function withParam(pairs, key, value) {
  return pairs.map((pair) => (pair[0] === key ? [key, value] : pair))
}

function signatureFor(method, path, pairs) {
  const canonical = pairs
    .filter(([key]) => key.toLowerCase() !== 'auth_signature')
    .map(([key, value]) => [key.toLowerCase(), value])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  return createHmac('sha256', APP_SECRET)
    .update(`${method.toUpperCase()}\n${path}\n${canonical}`)
    .digest('hex')
}

function signQuery(method, path, pairs) {
  return [...pairs, ['auth_signature', signatureFor(method, path, pairs)]]
}

function md5Hex(text) {
  return createHash('md5').update(text).digest('hex')
}

function rawAuth(prng, method, path, bodyText, extra) {
  const now = Math.floor(Date.now() / 1_000)
  const base = [
    ['auth_key', APP_KEY],
    ['auth_timestamp', String(now)],
    ['auth_version', '1.0'],
  ]
  if (bodyText !== '') base.push(['body_md5', md5Hex(bodyText)])
  const params = [...base, ...extra]
  const variants =
    bodyText === ''
      ? [
          'unsigned',
          'missing-signature',
          'wrong-key',
          'wrong-version',
          'stale-timestamp',
          'future-timestamp',
          'malformed-timestamp',
          'bad-signature',
          'short-signature',
          'nonhex-signature',
        ]
      : [
          'unsigned',
          'missing-signature',
          'wrong-key',
          'wrong-version',
          'stale-timestamp',
          'future-timestamp',
          'malformed-timestamp',
          'bad-signature',
          'short-signature',
          'nonhex-signature',
          'bad-body-md5',
          'missing-body-md5',
        ]
  const variant = prng.pick(variants)
  switch (variant) {
    case 'unsigned':
      return { label: 'unsigned request', pairs: extra }
    case 'missing-signature':
      return { label: 'missing auth_signature', pairs: params }
    case 'wrong-key':
      return {
        label: 'wrong auth_key',
        pairs: signQuery(method, path, withParam(params, 'auth_key', 'wrong-key')),
      }
    case 'wrong-version':
      return {
        label: 'wrong auth_version',
        pairs: signQuery(method, path, withParam(params, 'auth_version', '2.0')),
      }
    case 'stale-timestamp':
      return {
        label: 'stale auth_timestamp',
        pairs: signQuery(
          method,
          path,
          withParam(params, 'auth_timestamp', String(now - 3_600 - prng.int(0, 86_400))),
        ),
      }
    case 'future-timestamp':
      return {
        label: 'future auth_timestamp',
        pairs: signQuery(method, path, withParam(params, 'auth_timestamp', String(now + 3_600))),
      }
    case 'malformed-timestamp':
      return {
        label: 'malformed auth_timestamp',
        pairs: signQuery(
          method,
          path,
          withParam(params, 'auth_timestamp', prng.pick(['abc', '-1', '1e9', ' 1', '', '1.5'])),
        ),
      }
    case 'bad-signature':
      return { label: 'bad auth_signature', pairs: [...params, ['auth_signature', '0'.repeat(64)]] }
    case 'short-signature':
      return {
        label: 'short auth_signature',
        pairs: [
          ...params,
          ['auth_signature', signatureFor(method, path, params).slice(0, prng.int(1, 32))],
        ],
      }
    case 'nonhex-signature':
      return {
        label: 'non-hex auth_signature',
        pairs: [...params, ['auth_signature', 'z'.repeat(64)]],
      }
    case 'bad-body-md5':
      return {
        label: 'bad body_md5',
        pairs: signQuery(method, path, withParam(params, 'body_md5', '0'.repeat(32))),
      }
    default:
      return {
        label: 'missing body_md5',
        pairs: signQuery(
          method,
          path,
          params.filter(([key]) => key !== 'body_md5'),
        ),
      }
  }
}

function createHttpGenerator(prng) {
  return {
    next(iteration) {
      if (prng.bool(0.45)) return signedHttpCase(prng, iteration)
      return rawHttpCase(prng, iteration)
    },
  }
}

function signedHttpCase(prng, iteration) {
  const appId = prng.bool(0.75) ? '1' : prng.pick(['2', '01', '', '999'])
  const channel = sdkChannel(prng)
  const roll = prng.int(0, 99)
  let method
  let path
  let preferredBody = null
  if (roll < 45) {
    method = 'post'
    path = prng.bool(0.6) ? '/events' : '/batch_events'
    preferredBody = path === '/events' ? 'trigger' : 'batch'
  } else if (roll < 90) {
    method = 'get'
    path = sdkReadPath(prng, channel)
  } else {
    method = prng.bool(0.5) ? 'get' : 'post'
    path = sdkPath(prng, channel)
  }
  const params = randomQueryParams(prng)
  const body = method === 'post' ? createHttpBody(prng, channel, preferredBody) : null
  const bodyLabel = body === null ? 'no body' : body.label
  return {
    surface: 'http',
    iteration,
    kind: 'sdk',
    appId,
    method,
    path,
    params,
    body: body?.value,
    assertJson: true,
    describe: [
      `Pusher#${method} appId=${JSON.stringify(appId)} path=${JSON.stringify(path)}`,
      `params=${truncate(JSON.stringify(params), 1_000)}`,
      `body=${bodyLabel}`,
    ].join('\n'),
  }
}

function rawHttpCase(prng, iteration) {
  const path = rawPath(prng)
  const fixedMethod = path.startsWith('/app/') || path === '/healthz'
  const method = fixedMethod
    ? 'GET'
    : prng.pick(['GET', 'GET', 'POST', 'POST', 'PUT', 'DELETE', 'PATCH'])
  const body =
    method === 'GET'
      ? { label: 'no body for GET', raw: '', value: undefined }
      : createHttpBody(prng, randomHttpChannel(prng))
  let extra = randomRawParams(prng)
  if (path === `/app/${APP_KEY}`) {
    extra = [...extra.filter(([key]) => key !== 'protocol'), ['protocol', '7']]
  }
  const auth = rawAuth(prng, method, path, body.raw, extra)
  const query = new URLSearchParams()
  for (const [key, value] of auth.pairs) query.append(key, value)
  const queryText = query.toString()
  const url = queryText === '' ? path : `${path}?${queryText}`
  return {
    surface: 'http',
    iteration,
    kind: 'raw',
    method,
    path,
    query: auth.pairs,
    body: body.raw,
    bodyLabel: body.label,
    assertJson: path.startsWith('/apps') || path === '/healthz',
    describe: [
      `${method} ${truncate(url, 2_000)}`,
      `auth=${auth.label}`,
      `body=${body.label}`,
    ].join('\n'),
  }
}

async function runHttpCase(caseDef, ctx) {
  let status
  let responseBody = ''
  try {
    if (caseDef.kind === 'sdk') {
      const pusher = ctx.pusherFor(caseDef.appId)
      try {
        const response = await pusher[caseDef.method]({
          path: caseDef.path,
          params: caseDef.params,
          body: caseDef.body,
        })
        status = response.status
        responseBody = await response.text()
      } catch (error) {
        if (
          error !== null &&
          typeof error === 'object' &&
          'name' in error &&
          error.name === 'PusherRequestError' &&
          'status' in error &&
          typeof error.status === 'number'
        ) {
          status = error.status
          responseBody = typeof error.body === 'string' ? error.body : ''
        } else {
          throw error
        }
      }
    } else {
      const query = new URLSearchParams()
      for (const [key, value] of caseDef.query) query.append(key, value)
      const queryText = query.toString()
      const url = `${ctx.baseUrl}${caseDef.path}${queryText === '' ? '' : `?${queryText}`}`
      const response = await fetch(url, {
        method: caseDef.method,
        headers: caseDef.body === '' ? {} : { 'content-type': 'application/json' },
        body: caseDef.body === '' ? undefined : caseDef.body,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      status = response.status
      responseBody = await response.text()
    }
  } catch (error) {
    return httpFinding(caseDef, `request failed: ${describeError(error)}`, '')
  }

  ctx.reporter.countHttp(status)

  if (status >= 500) {
    return httpFinding(caseDef, `status ${status}`, responseBody)
  }

  if (caseDef.assertJson) {
    try {
      JSON.parse(responseBody)
    } catch {
      return httpFinding(caseDef, `status ${status} with a non-JSON body`, responseBody)
    }
  }

  return null
}

function httpFinding(caseDef, observed, body) {
  if (stopping) return STOPPED
  return {
    iteration: caseDef.iteration,
    surface: 'http',
    input: caseDef.describe,
    observed,
    body,
  }
}

function createWebSocketGenerator(prng, wsBase) {
  return {
    next(iteration) {
      const handshake = pickHandshake(prng, wsBase)
      const scenario = handshake.expect === 'open' ? pickScenario(prng) : null
      return { surface: 'ws', iteration, handshake, scenario }
    },
  }
}

function pickHandshake(prng, wsBase) {
  const variant = prng.pick([
    'valid',
    'valid',
    'valid',
    'valid',
    'valid',
    'valid',
    'missing',
    'protocol6',
    'protocol8',
    'protocolText',
    'wrongKey',
    'unknownPath',
  ])
  switch (variant) {
    case 'valid':
      return {
        label: 'protocol 7',
        url: `${wsBase}/app/${APP_KEY}?protocol=7`,
        expect: 'open',
      }
    case 'missing':
      return {
        label: 'missing protocol',
        url: `${wsBase}/app/${APP_KEY}`,
        expect: 4008,
      }
    case 'protocol6':
      return {
        label: 'protocol 6',
        url: `${wsBase}/app/${APP_KEY}?protocol=6`,
        expect: 4007,
      }
    case 'protocol8':
      return {
        label: 'protocol 8',
        url: `${wsBase}/app/${APP_KEY}?protocol=8`,
        expect: 4007,
      }
    case 'protocolText':
      return {
        label: 'non-numeric protocol',
        url: `${wsBase}/app/${APP_KEY}?protocol=fuzz`,
        expect: 4007,
      }
    case 'wrongKey':
      return {
        label: 'wrong key',
        url: `${wsBase}/app/wrong-key?protocol=7`,
        expect: 4001,
      }
    default:
      return {
        label: 'unknown path',
        url: `${wsBase}/${prng.pick(['nope', `app/${APP_KEY}/extra`])}?protocol=7`,
        expect: 4005,
      }
  }
}

function pickScenario(prng) {
  return {
    kind: prng.pick([
      'ping',
      'pong',
      'invalid-json',
      'random-string',
      'bad-envelope',
      'public-subscribe',
      'private-subscribe',
      'presence-subscribe',
      'cache-subscribe',
      'encrypted-subscribe',
      'bad-auth-private',
      'bad-auth-presence',
      'bad-auth-key',
      'client-public',
      'client-private-subscribed',
      'client-private-unsubscribed',
      'client-presence-subscribed',
      'client-oversize',
      'unsubscribe',
      'binary',
      'oversize',
      'invalid-channel',
      'rate-limit',
      'malformed-then-ping',
      'double-subscribe',
    ]),
    suffix: randomToken(prng, 8),
    oversizedData: randomToken(prng, MAX_DATA_BYTES + 1_000),
    garbage: prng.pick([
      `random garbage ${randomToken(prng, prng.int(1, 30))}`,
      `{${randomToken(prng, 10)}`,
      'null',
      '[]',
      '{"event":',
      '{"event":"pusher:ping","data":"unterminated}',
      '\u0000\u0001\uffff',
    ]),
    privateCache: prng.bool(0.5),
  }
}

function subscribePayload(channel, auth) {
  const data = { channel }
  if (auth !== undefined) {
    data.auth = auth.auth
    if (auth.channel_data !== undefined) data.channel_data = auth.channel_data
  }
  return JSON.stringify({ event: 'pusher:subscribe', data })
}

function clientPayload(channel, data) {
  return JSON.stringify({ event: 'client-fuzz', channel, data })
}

function buildScenario(scenario, socketId, pusher) {
  const { kind, suffix } = scenario
  switch (kind) {
    case 'ping':
      return {
        label: 'ping',
        steps: [
          {
            label: 'pusher:ping',
            payload: PING_PAYLOAD,
            expect: { kind: 'pong' },
          },
        ],
      }
    case 'pong':
      return {
        label: 'pong',
        steps: [
          {
            label: 'pusher:pong',
            payload: JSON.stringify({ event: 'pusher:pong' }),
            expect: { kind: 'none' },
          },
        ],
      }
    case 'invalid-json':
      return {
        label: 'invalid JSON',
        steps: [
          {
            label: 'invalid JSON',
            payload: '{not json',
            expect: { kind: 'error', codes: [4300] },
          },
        ],
      }
    case 'random-string':
      return {
        label: 'random string',
        steps: [
          {
            label: 'random string',
            payload: scenario.garbage,
            expect: { kind: 'error', codes: [4300] },
          },
        ],
      }
    case 'bad-envelope':
      return {
        label: 'unknown event',
        steps: [
          {
            label: 'unknown event',
            payload: JSON.stringify({ event: 'fuzz:unknown', data: {} }),
            expect: { kind: 'error', codes: [4300] },
          },
        ],
      }
    case 'public-subscribe': {
      const channel = `public-${suffix}`
      return {
        label: `subscribe ${channel}`,
        steps: [
          {
            label: `subscribe ${channel}`,
            payload: subscribePayload(channel),
            expect: { kind: 'subscribed', channel },
          },
        ],
      }
    }
    case 'private-subscribe': {
      const channel = `private-${suffix}`
      const auth = pusher.authorizeChannel(socketId, channel)
      return {
        label: `subscribe ${channel} with valid auth`,
        steps: [
          {
            label: `subscribe ${channel}`,
            payload: subscribePayload(channel, auth),
            expect: { kind: 'subscribed', channel },
          },
        ],
      }
    }
    case 'presence-subscribe': {
      const channel = `presence-${suffix}`
      const auth = pusher.authorizeChannel(socketId, channel, {
        user_id: `user-${suffix}`,
        user_info: { fuzz: true },
      })
      return {
        label: `subscribe ${channel} with valid presence auth`,
        steps: [
          {
            label: `subscribe ${channel}`,
            payload: subscribePayload(channel, auth),
            expect: { kind: 'subscribed', channel },
          },
        ],
      }
    }
    case 'cache-subscribe': {
      const channel = scenario.privateCache ? `private-cache-${suffix}` : `cache-${suffix}`
      const auth = scenario.privateCache ? pusher.authorizeChannel(socketId, channel) : undefined
      return {
        label: `subscribe ${channel}`,
        steps: [
          {
            label: `subscribe ${channel}`,
            payload: subscribePayload(channel, auth),
            expect: { kind: 'subscribed', channel },
          },
        ],
      }
    }
    case 'encrypted-subscribe': {
      const channel = `private-encrypted-${suffix}`
      return {
        label: `subscribe ${channel}`,
        terminalClose: true,
        steps: [
          {
            label: `subscribe ${channel}`,
            payload: subscribePayload(channel),
            expect: { kind: 'error', codes: [4009] },
          },
        ],
      }
    }
    case 'bad-auth-private': {
      const channel = `private-${suffix}`
      return {
        label: `subscribe ${channel} with a bad signature`,
        terminalClose: true,
        steps: [
          {
            label: `subscribe ${channel}`,
            payload: subscribePayload(channel, { auth: `${APP_KEY}:${'0'.repeat(64)}` }),
            expect: { kind: 'error', codes: [4009] },
          },
        ],
      }
    }
    case 'bad-auth-presence': {
      const channel = `presence-${suffix}`
      return {
        label: `subscribe ${channel} without channel_data`,
        terminalClose: true,
        steps: [
          {
            label: `subscribe ${channel}`,
            payload: subscribePayload(channel, { auth: `${APP_KEY}:${'0'.repeat(64)}` }),
            expect: { kind: 'error', codes: [4009] },
          },
        ],
      }
    }
    case 'bad-auth-key': {
      const channel = `private-${suffix}`
      const signature = createHmac('sha256', APP_SECRET)
        .update(`${socketId}:${channel}`)
        .digest('hex')
      return {
        label: `subscribe ${channel} with a wrong auth key`,
        terminalClose: true,
        steps: [
          {
            label: `subscribe ${channel}`,
            payload: subscribePayload(channel, { auth: `wrong-key:${signature}` }),
            expect: { kind: 'error', codes: [4009] },
          },
        ],
      }
    }
    case 'client-public': {
      const channel = `public-${suffix}`
      return {
        label: `client event on unsubscribed public ${channel}`,
        steps: [
          {
            label: 'client event',
            payload: clientPayload(channel, { fuzz: true }),
            expect: { kind: 'error', codes: [4300] },
          },
        ],
      }
    }
    case 'client-private-subscribed': {
      const channel = `private-${suffix}`
      const auth = pusher.authorizeChannel(socketId, channel)
      return {
        label: `client event after subscribing ${channel}`,
        steps: [
          {
            label: `subscribe ${channel}`,
            payload: subscribePayload(channel, auth),
            expect: { kind: 'subscribed', channel },
          },
          {
            label: 'client event',
            payload: clientPayload(channel, { fuzz: true }),
            expect: { kind: 'none' },
          },
        ],
      }
    }
    case 'client-private-unsubscribed': {
      const channel = `private-${suffix}`
      return {
        label: `client event on unsubscribed private ${channel}`,
        steps: [
          {
            label: 'client event',
            payload: clientPayload(channel, { fuzz: true }),
            expect: { kind: 'error', codes: [4300] },
          },
        ],
      }
    }
    case 'client-presence-subscribed': {
      const channel = `presence-${suffix}`
      const auth = pusher.authorizeChannel(socketId, channel, {
        user_id: `user-${suffix}`,
        user_info: { fuzz: true },
      })
      return {
        label: `client event after subscribing ${channel}`,
        steps: [
          {
            label: `subscribe ${channel}`,
            payload: subscribePayload(channel, auth),
            expect: { kind: 'subscribed', channel },
          },
          {
            label: 'client event',
            payload: clientPayload(channel, { fuzz: true }),
            expect: { kind: 'none' },
          },
        ],
      }
    }
    case 'client-oversize': {
      const channel = `private-${suffix}`
      const auth = pusher.authorizeChannel(socketId, channel)
      return {
        label: `oversized client event after subscribing ${channel}`,
        steps: [
          {
            label: `subscribe ${channel}`,
            payload: subscribePayload(channel, auth),
            expect: { kind: 'subscribed', channel },
          },
          {
            label: 'client event with 11KB data',
            payload: clientPayload(channel, scenario.oversizedData),
            expect: { kind: 'error', codes: [4300] },
          },
        ],
      }
    }
    case 'unsubscribe': {
      const channel = `public-${suffix}`
      return {
        label: `subscribe then unsubscribe ${channel}`,
        steps: [
          {
            label: `subscribe ${channel}`,
            payload: subscribePayload(channel),
            expect: { kind: 'subscribed', channel },
          },
          {
            label: `unsubscribe ${channel}`,
            payload: JSON.stringify({ event: 'pusher:unsubscribe', data: { channel } }),
            expect: { kind: 'none' },
          },
        ],
      }
    }
    case 'binary':
      return {
        label: 'binary frame',
        steps: [
          {
            label: '4-byte binary frame',
            payload: new Uint8Array([0, 1, 2, 255]).buffer,
            expect: { kind: 'error', codes: [4300] },
          },
        ],
      }
    case 'oversize':
      return {
        label: 'frame over 64KB',
        steps: [
          {
            label: '70KB text frame',
            payload: JSON.stringify({ event: 'pusher:ping', data: 'x'.repeat(70 * 1_024) }),
            expect: { kind: 'error', codes: [4300] },
          },
        ],
      }
    case 'invalid-channel':
      return {
        label: 'subscribe to an invalid channel name',
        steps: [
          {
            label: 'subscribe to "has space"',
            payload: JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'has space' } }),
            expect: { kind: 'error', codes: [4300] },
          },
        ],
      }
    case 'rate-limit': {
      const channel = `private-${suffix}`
      const auth = pusher.authorizeChannel(socketId, channel)
      const steps = [
        {
          label: `subscribe ${channel}`,
          payload: subscribePayload(channel, auth),
          expect: { kind: 'subscribed', channel },
        },
      ]
      for (let index = 0; index < 10; index += 1) {
        steps.push({
          label: `client event ${index + 1}`,
          payload: clientPayload(channel, { index }),
          expect: { kind: 'none' },
        })
      }
      steps.push({
        label: 'client event 11',
        payload: clientPayload(channel, { index: 10 }),
        expect: { kind: 'error', codes: [4301] },
      })
      return { label: '11 client events in one second', steps }
    }
    case 'malformed-then-ping':
      return {
        label: 'malformed frame then ping',
        steps: [
          {
            label: 'invalid JSON',
            payload: '{not json',
            expect: { kind: 'error', codes: [4300] },
          },
          {
            label: 'pusher:ping',
            payload: PING_PAYLOAD,
            expect: { kind: 'pong' },
          },
        ],
      }
    default: {
      const channel = `public-${suffix}`
      return {
        label: `subscribe ${channel} twice`,
        steps: [
          {
            label: `subscribe ${channel}`,
            payload: subscribePayload(channel),
            expect: { kind: 'subscribed', channel },
          },
          {
            label: `subscribe ${channel} again`,
            payload: subscribePayload(channel),
            expect: { kind: 'subscribed', channel },
          },
        ],
      }
    }
  }
}

function matchFrame(frame, expect) {
  const parsed = frame.parsed
  switch (expect.kind) {
    case 'event':
      return parsed !== null && parsed.event === expect.event
    case 'pong':
      return parsed !== null && parsed.event === 'pusher:pong'
    case 'error':
      return (
        parsed !== null &&
        parsed.event === 'pusher:error' &&
        expect.codes.includes(parsed.data?.code)
      )
    case 'subscribed':
      return (
        parsed !== null &&
        parsed.event === 'pusher_internal:subscription_succeeded' &&
        parsed.channel === expect.channel
      )
    default:
      return false
  }
}

function describeExpect(expect) {
  switch (expect.kind) {
    case 'event':
      return expect.event
    case 'pong':
      return 'pusher:pong'
    case 'subscribed':
      return `subscription_succeeded for ${expect.channel}`
    case 'error':
      return `pusher:error ${expect.codes.join('/')}`
    default:
      return 'no frame'
  }
}

function parseFrameText(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new FuzzTimeout(`${label} did not finish within ${timeoutMs}ms`)),
      timeoutMs,
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function createSocket(url) {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const frames = []
  const frameWaiters = []
  const closeWaiters = []
  const openWaiters = []
  let opened = false
  let closeInfo = null

  const flush = () => {
    while (frameWaiters.length > 0) {
      const waiter = frameWaiters[0]
      if (frames.length > 0) {
        frameWaiters.shift()
        waiter.resolve(frames.shift())
        continue
      }
      if (closeInfo !== null) {
        frameWaiters.shift()
        waiter.reject(new SocketClosed(closeInfo))
        continue
      }
      break
    }
    if (closeInfo !== null && closeWaiters.length > 0) {
      for (const resolve of closeWaiters.splice(0)) resolve(closeInfo)
    }
  }

  ws.addEventListener('open', () => {
    opened = true
    for (const waiter of openWaiters.splice(0)) waiter.resolve()
  })

  ws.addEventListener('message', (event) => {
    let text
    if (typeof event.data === 'string') {
      text = event.data
    } else if (event.data instanceof ArrayBuffer) {
      text = Buffer.from(event.data).toString('utf8')
    } else {
      text = String(event.data)
    }
    frames.push({ text, parsed: parseFrameText(text) })
    flush()
  })

  ws.addEventListener('close', (event) => {
    closeInfo = { code: event.code, reason: event.reason ?? '' }
    for (const waiter of openWaiters.splice(0)) waiter.reject(new SocketClosed(closeInfo))
    flush()
  })

  ws.addEventListener('error', () => {})

  return {
    get closed() {
      return closeInfo !== null
    },
    get closeInfo() {
      return closeInfo
    },
    waitOpen(timeoutMs) {
      if (opened) return Promise.resolve()
      if (closeInfo !== null) return Promise.reject(new SocketClosed(closeInfo))
      return withTimeout(
        new Promise((resolve, reject) => {
          openWaiters.push({ resolve, reject })
        }),
        timeoutMs,
        'socket open',
      )
    },
    waitFrame(timeoutMs) {
      if (frames.length > 0) return Promise.resolve(frames.shift())
      if (closeInfo !== null) return Promise.reject(new SocketClosed(closeInfo))
      return withTimeout(
        new Promise((resolve, reject) => {
          frameWaiters.push({ resolve, reject })
        }),
        timeoutMs,
        'websocket frame',
      )
    },
    waitClose(timeoutMs) {
      if (closeInfo !== null) return Promise.resolve(closeInfo)
      return withTimeout(
        new Promise((resolve) => {
          closeWaiters.push(resolve)
        }),
        timeoutMs,
        'socket close',
      )
    },
    async expect(match, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          throw new FuzzTimeout(`waiting for ${describeExpect(match)} exceeded ${timeoutMs}ms`)
        }
        let frame
        try {
          frame = await this.waitFrame(remaining)
        } catch (error) {
          if (error instanceof SocketClosed) {
            return { kind: 'closed', close: error.info }
          }
          throw error
        }
        if (matchFrame(frame, match)) return { kind: 'frame', frame }
        if (frame.parsed !== null && frame.parsed.event === 'pusher:error') {
          return { kind: 'unexpected-error', frame }
        }
      }
    },
    send(payload) {
      if (closeInfo !== null) throw new SocketClosed(closeInfo)
      ws.send(payload)
    },
    async closeClean(timeoutMs) {
      if (closeInfo !== null) return closeInfo
      try {
        ws.close(1_000)
      } catch {}
      return this.waitClose(timeoutMs)
    },
    dispose() {
      if (closeInfo !== null) return
      try {
        ws.close()
      } catch {}
    },
  }
}

function readSocketId(frame) {
  const data = frame.parsed?.data
  if (typeof data !== 'string') return null
  const parsed = parseFrameText(data)
  if (parsed === null || typeof parsed.socket_id !== 'string') return null
  return /^\d+\.\d+$/.test(parsed.socket_id) ? parsed.socket_id : null
}

function previewPayload(payload) {
  if (typeof payload === 'string') return truncate(payload, 500)
  if (payload instanceof ArrayBuffer) return `<binary ${payload.byteLength} bytes>`
  return truncate(String(payload), 500)
}

function wsInput(caseDef, plan, stepLabel) {
  const lines = [`handshake: ${caseDef.handshake.url}`]
  if (plan !== null) {
    lines.push(`scenario: ${plan.label}`)
    for (const step of plan.steps) {
      const marker = step.label === stepLabel ? ' (current)' : ''
      lines.push(`send ${step.label}${marker}: ${previewPayload(step.payload)}`)
    }
  }
  return lines.join('\n')
}

function wsFinding(caseDef, observed, body, plan = null, stepLabel = '') {
  if (stopping) return STOPPED
  return {
    iteration: caseDef.iteration,
    surface: 'websocket',
    input: wsInput(caseDef, plan, stepLabel),
    observed,
    body,
  }
}

function closeFinding(caseDef, close, plan, stepLabel) {
  if (ALLOWED_CLOSE_CODES.has(close.code)) return null
  return wsFinding(
    caseDef,
    `close ${close.code}`,
    `close reason: ${close.reason === '' ? '(none)' : close.reason}`,
    plan,
    stepLabel,
  )
}

async function runWebSocketCase(caseDef, ctx) {
  const socket = createSocket(caseDef.handshake.url)
  let plan = null
  let stepLabel = 'handshake'

  try {
    if (caseDef.handshake.expect !== 'open') {
      let close
      try {
        close = await socket.waitClose(WS_TIMEOUT_MS)
      } catch (error) {
        const finding = wsFinding(
          caseDef,
          `hang: no close within ${WS_TIMEOUT_MS}ms`,
          describeError(error),
        )
        ctx.reporter.countWs('hang')
        return finding
      }
      if (close.code !== caseDef.handshake.expect) {
        ctx.reporter.countWs(`close ${close.code}`)
        return wsFinding(
          caseDef,
          `close ${close.code}`,
          `expected close ${caseDef.handshake.expect}, reason: ${close.reason}`,
        )
      }
      ctx.reporter.countWs(`rejected ${close.code}`)
      return null
    }

    try {
      await socket.waitOpen(WS_TIMEOUT_MS)
    } catch (error) {
      if (error instanceof SocketClosed) {
        ctx.reporter.countWs(`close ${error.info.code}`)
        return wsFinding(caseDef, `close ${error.info.code} before open`, error.info.reason)
      }
      ctx.reporter.countWs('hang')
      return wsFinding(caseDef, 'hang: socket did not open', describeError(error))
    }

    const established = await socket.expect(
      { kind: 'event', event: 'pusher:connection_established' },
      WS_TIMEOUT_MS,
    )
    if (established.kind === 'closed') {
      ctx.reporter.countWs(`close ${established.close.code}`)
      return wsFinding(
        caseDef,
        `close ${established.close.code} before connection_established`,
        established.close.reason,
      )
    }
    if (established.kind === 'unexpected-error') {
      return wsFinding(
        caseDef,
        'pusher:error before connection_established',
        established.frame.text,
      )
    }
    const socketId = readSocketId(established.frame)
    if (socketId === null) {
      return wsFinding(
        caseDef,
        'connection_established without a socket id',
        established.frame.text,
      )
    }

    plan = buildScenario(caseDef.scenario, socketId, ctx.pusherFor(APP_ID))

    let closeInfo = socket.closeInfo
    for (const step of plan.steps) {
      stepLabel = step.label
      if (closeInfo !== null) break

      try {
        socket.send(step.payload)
      } catch (error) {
        if (error instanceof SocketClosed) {
          closeInfo = error.info
          break
        }
        throw error
      }

      if (step.expect.kind === 'none') continue

      const outcome = await socket.expect(step.expect, WS_TIMEOUT_MS)
      if (outcome.kind === 'frame') continue
      if (outcome.kind === 'unexpected-error') {
        const code = outcome.frame.parsed?.data?.code
        return wsFinding(
          caseDef,
          `unexpected pusher:error ${code}`,
          outcome.frame.text,
          plan,
          stepLabel,
        )
      }
      if (step.expect.kind === 'subscribed' || step.expect.kind === 'pong') {
        ctx.reporter.countWs(`close ${outcome.close.code}`)
        return wsFinding(
          caseDef,
          `close ${outcome.close.code} while waiting for ${describeExpect(step.expect)}`,
          outcome.close.reason,
          plan,
          stepLabel,
        )
      }
      if (!ALLOWED_CLOSE_CODES.has(outcome.close.code)) {
        return wsFinding(
          caseDef,
          `close ${outcome.close.code}`,
          outcome.close.reason,
          plan,
          stepLabel,
        )
      }
      closeInfo = outcome.close
      break
    }

    if (closeInfo === null && plan.terminalClose === true) {
      try {
        closeInfo = await socket.waitClose(WS_TIMEOUT_MS)
      } catch {
        return wsFinding(
          caseDef,
          'socket stayed open after 4009',
          `no close within ${WS_TIMEOUT_MS}ms`,
          plan,
          stepLabel,
        )
      }
    }

    if (closeInfo === null) {
      try {
        socket.send(PING_PAYLOAD)
      } catch (error) {
        if (error instanceof SocketClosed) {
          closeInfo = error.info
        } else {
          throw error
        }
      }
    }

    if (closeInfo === null) {
      const outcome = await socket.expect({ kind: 'pong' }, WS_TIMEOUT_MS)
      if (outcome.kind === 'closed') {
        ctx.reporter.countWs(`close ${outcome.close.code}`)
        const finding = closeFinding(caseDef, outcome.close, plan, stepLabel)
        return finding ?? null
      }
      if (outcome.kind === 'unexpected-error') {
        return wsFinding(
          caseDef,
          `pusher:error ${outcome.frame.parsed?.data?.code} while waiting for pusher:pong`,
          outcome.frame.text,
          plan,
          stepLabel,
        )
      }
    }

    if (closeInfo !== null) {
      ctx.reporter.countWs(`open, close ${closeInfo.code}`)
      return closeFinding(caseDef, closeInfo, plan, stepLabel)
    }

    const close = await socket.closeClean(WS_TIMEOUT_MS)
    if (close.code !== 1_000) {
      ctx.reporter.countWs(`open, close ${close.code}`)
      return wsFinding(
        caseDef,
        `own clean close returned ${close.code}`,
        close.reason,
        plan,
        stepLabel,
      )
    }
    ctx.reporter.countWs('open, close 1000')
    return null
  } catch (error) {
    if (error instanceof FuzzTimeout) {
      ctx.reporter.countWs('hang')
      return wsFinding(caseDef, `hang: ${error.message}`, '', plan, stepLabel)
    }
    if (error instanceof SocketClosed) {
      ctx.reporter.countWs(`close ${error.info.code}`)
      return closeFinding(caseDef, error.info, plan, stepLabel)
    }
    throw error
  } finally {
    socket.dispose()
  }
}

async function fuzzCases(reporter, seed, iterations, baseUrl, wsBase, port) {
  const prng = createPrng(seed)
  const httpGenerator = createHttpGenerator(prng)
  const wsGenerator = createWebSocketGenerator(prng, wsBase)
  const ctx = {
    baseUrl,
    reporter,
    pusherFor: createPusherFor(port),
  }

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    if (stopping) return STOPPED
    if (server !== null && hasExited(server)) {
      return {
        iteration,
        surface: 'server',
        input: 'local Vite dev server',
        observed: `server exited with code ${server.exitCode ?? server.signalCode}`,
        body: '',
      }
    }

    const caseDef = prng.bool(0.55) ? httpGenerator.next(iteration) : wsGenerator.next(iteration)
    const finding =
      caseDef.surface === 'http'
        ? await runHttpCase(caseDef, ctx)
        : await runWebSocketCase(caseDef, ctx)
    if (finding === STOPPED) return STOPPED
    if (finding !== null) return finding

    if ((iteration + 1) % 50 === 0) {
      console.log(`progress ${iteration + 1}/${iterations}`)
    }
  }

  if (stopping) return STOPPED

  if (server !== null && hasExited(server)) {
    return {
      iteration: iterations - 1,
      surface: 'server',
      input: 'local Vite dev server',
      observed: `server exited with code ${server.exitCode ?? server.signalCode}`,
      body: '',
    }
  }

  const afterHttp = await checkHealth(baseUrl, 'after http cases', iterations - 1)
  if (afterHttp !== null) return afterHttp
  return checkHealth(baseUrl, 'after websocket cases', iterations - 1)
}

async function run() {
  const seed = readSeed()
  const iterations = readIterations()
  const port = readPort() ?? (await findFreePort(DEFAULT_PORT))
  const baseUrl = `http://${HOST}:${port}`
  const wsBase = `ws://${HOST}:${port}`
  const reporter = new FindingReporter(seed, iterations)
  reporter.start()

  try {
    backupDevVars()
    server = startServer(port)
    await waitForHealthz(baseUrl)
    console.log(`local dev server ready at ${baseUrl}`)
    const app = await bootstrap(baseUrl, 'fuzz')
    APP_ID = app.appId
    APP_KEY = app.key
    APP_SECRET = app.secret
    console.log(`bootstrap app ${APP_ID} created`)
    const finding = await fuzzCases(reporter, seed, iterations, baseUrl, wsBase, port)
    if (finding === STOPPED) return 0
    if (finding !== null) {
      if (stopping) return 0
      reporter.report(finding)
      return 1
    }
    reporter.summary()
    return 0
  } catch (error) {
    if (!stopping) {
      reporter.report({
        iteration: 0,
        surface: 'harness',
        input: `pnpm exec vite --host ${HOST} --port ${port} --strictPort`,
        observed: describeError(error),
        body: '',
      })
    }
    return 1
  } finally {
    await cleanup()
  }
}

for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.on(signal, () => {
    stopSignal = code
    stopping = true
    cleanup().finally(() => process.exit(code))
  })
}

try {
  const code = await run()
  await cleanup()
  process.exit(stopSignal ?? code)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`fuzz: ${message}`)
  await cleanup()
  process.exit(1)
}
