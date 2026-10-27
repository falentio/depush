import { spawn } from 'node:child_process'
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { bootstrap, DEV_VARS_CONTENT } from './bootstrap.mjs'

const HOST = '127.0.0.1'
const DEFAULT_PORT = 8792
const CLOUD_KEYS = ['PUSHER_CLOUD_APP_ID', 'PUSHER_CLOUD_APP_KEY', 'PUSHER_CLOUD_APP_SECRET']
const DEV_VARS = '.dev.vars'
const DEV_VARS_BACKUP = '.dev.vars.test-compat-backup'
const HEALTH_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 5_000

let server = null
let vitest = null
let serverLog = ''
let cleanupPromise = null
let devVarsManaged = false

function readStartPort() {
  const raw = process.env.PUSHER_COMPAT_PORT
  if (raw === undefined || raw === '') return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PUSHER_COMPAT_PORT must be an integer from 1 to 65535')
  }
  return port
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

function cloudEnv(source) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => key.startsWith('PUSHER_CLOUD_')),
  )
}

function cloudEnabled(source) {
  return CLOUD_KEYS.every((key) => {
    const value = source[key]
    return value !== undefined && value !== ''
  })
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
    serverLog = `${serverLog}${chunk}`.slice(-8000)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  return child
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
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
    } catch {
      // The process group is already gone.
    }
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
    await stopChild(vitest)
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

async function waitForHealthz(baseUrl, child) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (hasExited(child)) {
      throw new Error(`local dev server exited before /healthz answered`)
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`)
      if (response.ok) {
        const body = await response.json()
        if (isHealthy(body)) return
      }
    } catch {
      // The server is still starting.
    }
    await delay(200)
  }
  throw new Error(`local dev server did not answer /healthz within 30s`)
}

function runVitest(baseUrl, cloud, app) {
  return spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.compat.config.ts'], {
    detached: true,
    env: {
      ...withoutLocalAppEnv(process.env),
      ...cloud,
      DEPUSH_BASE_URL: baseUrl,
      DEPUSH_APP_ID: app.appId,
      DEPUSH_APP_KEY: app.key,
      DEPUSH_APP_SECRET: app.secret,
    },
    stdio: 'inherit',
  })
}

function exitCode(child) {
  if (hasExited(child)) return Promise.resolve(child.exitCode ?? 1)
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code ?? 1))
  })
}

async function main() {
  const start = readStartPort()
  const port = await findFreePort(start)
  const baseUrl = `http://${HOST}:${port}`
  const cloud = cloudEnv(process.env)
  const compareWithCloud = cloudEnabled(process.env)

  backupDevVars()
  server = startServer(port)
  try {
    await waitForHealthz(baseUrl, server)
  } catch (error) {
    if (serverLog.length > 0) console.error(`--- dev server output ---\n${serverLog}`)
    throw error
  }

  console.log(`local dev server ready at ${baseUrl}`)
  console.log(`cloud comparison ${compareWithCloud ? 'enabled' : 'disabled'}`)

  const app = await bootstrap(baseUrl, 'test-compat')
  console.log(`bootstrap app ${app.appId} created`)

  vitest = runVitest(baseUrl, cloud, app)
  return exitCode(vitest)
}

for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.on(signal, () => {
    cleanup().finally(() => process.exit(code))
  })
}

try {
  const code = await main()
  await cleanup()
  process.exit(code)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  await cleanup()
  process.exit(1)
}
