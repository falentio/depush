import { spawn } from 'node:child_process'
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOST = '127.0.0.1'
const PORT = 4173
const BASE = `http://${HOST}:${PORT}`
const DEV_VARS = `${ROOT}.dev.vars`
const BACKUP = `${ROOT}.dev.vars.verify-frontend-backup`
const SECRET = 'verify-frontend-better-auth-secret-0123456789'

let child = null
let serverLog = ''
let devVarsManaged = false
let exiting = false

const failures = []
let passed = 0

function pass(label) {
  passed += 1
  console.log(`PASS ${label}`)
}

function fail(label, detail) {
  failures.push({ label, detail })
  console.error(`FAIL ${label}: ${detail}`)
}

async function check(label, run) {
  try {
    await run()
    pass(label)
  } catch (error) {
    fail(label, error instanceof Error ? error.message : String(error))
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function backupDevVars() {
  if (existsSync(DEV_VARS)) renameSync(DEV_VARS, BACKUP)
  writeFileSync(DEV_VARS, `BETTER_AUTH_SECRET=${SECRET}\n`)
  devVarsManaged = true
}

function restoreDevVars() {
  if (!devVarsManaged) return
  if (existsSync(BACKUP)) renameSync(BACKUP, DEV_VARS)
  else if (existsSync(DEV_VARS)) unlinkSync(DEV_VARS)
  devVarsManaged = false
}

function startPreview() {
  const spawned = spawn(
    'pnpm',
    ['exec', 'vite', 'preview', '--host', HOST, '--port', String(PORT), '--strictPort'],
    {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const collect = (chunk) => {
    serverLog = `${serverLog}${chunk}`.slice(-12_000)
  }
  spawned.stdout.on('data', collect)
  spawned.stderr.on('data', collect)
  return spawned
}

async function stopPreview() {
  if (child === null || child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {}
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)])
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {}
  child = null
}

async function cleanup() {
  if (exiting) return
  exiting = true
  await stopPreview()
  restoreDevVars()
}

async function waitForHealth(deadlineMs = 30_000) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/healthz`)
      const body = await response.json()
      if (response.ok && body.status === 'ok') return
    } catch {}
    await delay(200)
  }
  throw new Error('vite preview did not answer /healthz within 30s')
}

async function get(path, init) {
  return fetch(`${BASE}${path}`, init)
}

async function assertHtml(path) {
  const response = await get(path)
  const body = await response.text()
  assert(response.status === 200, `${path}: expected 200, got ${response.status}`)
  assert(
    (response.headers.get('content-type') ?? '').includes('text/html'),
    `${path}: expected text/html, got ${response.headers.get('content-type')}`,
  )
  assert(body.includes('id="root"'), `${path}: HTML is missing the root element`)
}

async function checkBuildOutput() {
  const required = [
    'dist/client/index.html',
    'dist/client/sw.js',
    'dist/client/manifest.webmanifest',
    'dist/client/pwa-192x192.png',
    'dist/client/pwa-512x512.png',
    'dist/client/maskable-icon-512x512.png',
    'dist/client/apple-touch-icon.png',
    'dist/client/icon.svg',
    'dist/depush/wrangler.json',
  ]
  for (const file of required) {
    assert(existsSync(`${ROOT}${file}`), `missing build output: ${file}`)
  }

  const assets = await readFile(`${ROOT}dist/client/index.html`, 'utf8')
  assert(/assets\/index-[A-Za-z0-9_-]+\.js/.test(assets), 'index.html has no hashed JS asset')
  assert(/assets\/index-[A-Za-z0-9_-]+\.css/.test(assets), 'index.html has no hashed CSS asset')

  const sw = await readFile(`${ROOT}dist/client/sw.js`, 'utf8')
  assert(sw.includes('precacheAndRoute'), 'sw.js has no precache route')
  assert(sw.includes('index.html'), 'sw.js does not precache index.html')
  assert(/assets\/index-[A-Za-z0-9_-]+\.js/.test(sw), 'sw.js does not precache the JS asset')
  assert(!/url:"\/api/.test(sw), 'sw.js precaches an /api path')
  assert(sw.includes('^\\/api'), 'sw.js navigation denylist is missing /api')
  assert(sw.includes('^\\/healthz'), 'sw.js navigation denylist is missing /healthz')

  const generated = JSON.parse(await readFile(`${ROOT}dist/depush/wrangler.json`, 'utf8'))
  assert(generated.main === 'index.js', 'generated wrangler main is not index.js')
  assert(generated.no_bundle === true, 'generated wrangler no_bundle is not true')
  assert(
    generated.assets?.not_found_handling === 'single-page-application',
    'generated wrangler is missing the SPA fallback',
  )
  assert(
    generated.assets?.directory === '../client',
    `generated assets.directory is ${generated.assets?.directory}`,
  )
  assert(
    JSON.stringify(generated.assets?.run_worker_first) ===
      JSON.stringify(['/api', '/api/*', '/apps/*', '/app/*', '/healthz']),
    'generated run_worker_first does not match the Worker route table',
  )
}

async function checkPreview() {
  const html = await get('/console/apps')
  const index = await html.text()
  assert(html.status === 200, `/console/apps: expected 200, got ${html.status}`)
  assert(
    (html.headers.get('content-type') ?? '').includes('text/html'),
    `/console/apps: expected text/html, got ${html.headers.get('content-type')}`,
  )
  assert(index.includes('id="root"'), '/console/apps: HTML is missing the root element')

  for (const path of ['/', '/console', '/console/apps', '/console/settings', '/console/nope']) {
    await assertHtml(path)
  }

  const apps = await get('/api/apps')
  assert(apps.status === 401, `/api/apps: expected 401, got ${apps.status}`)
  assert(
    (apps.headers.get('content-type') ?? '').includes('application/json'),
    `/api/apps: expected application/json, got ${apps.headers.get('content-type')}`,
  )

  const api = await get('/api')
  assert(api.status === 404, `/api: expected 404, got ${api.status}`)
  assert(
    (api.headers.get('content-type') ?? '').includes('application/json'),
    `/api: expected application/json, got ${api.headers.get('content-type')}`,
  )

  const session = await get('/api/auth/get-session')
  assert(session.status === 200, `/api/auth/get-session: expected 200, got ${session.status}`)
  assert((await session.json()) === null, '/api/auth/get-session: expected null')

  const events = await get('/apps/x/events', { method: 'POST' })
  assert(events.status === 401, `/apps/x/events: expected 401, got ${events.status}`)
  assert(
    (events.headers.get('content-type') ?? '').includes('application/json'),
    '/apps/x/events: expected application/json',
  )

  const health = await get('/healthz')
  assert(health.status === 200, `/healthz: expected 200, got ${health.status}`)
  assert((await health.json()).status === 'ok', '/healthz: status is not ok')

  const sw = await get('/sw.js')
  assert(sw.status === 200, `/sw.js: expected 200, got ${sw.status}`)
  assert(
    (sw.headers.get('content-type') ?? '').includes('javascript'),
    `/sw.js: expected JavaScript, got ${sw.headers.get('content-type')}`,
  )
  assert((await sw.text()).includes('precacheAndRoute'), '/sw.js: no precache route')

  const manifest = await get('/manifest.webmanifest')
  assert(manifest.status === 200, `/manifest.webmanifest: expected 200, got ${manifest.status}`)
  const manifestBody = await manifest.json()
  assert(manifestBody.start_url === '/console', 'manifest start_url is not /console')
  assert(manifestBody.scope === '/console', 'manifest scope is not /console')
  assert(manifestBody.display === 'standalone', 'manifest display is not standalone')
  assert(
    Array.isArray(manifestBody.icons) && manifestBody.icons.length >= 3,
    'manifest is missing icons',
  )

  for (const icon of ['/pwa-192x192.png', '/pwa-512x512.png', '/maskable-icon-512x512.png']) {
    const response = await get(icon)
    assert(response.status === 200, `${icon}: expected 200, got ${response.status}`)
    assert(
      (response.headers.get('content-type') ?? '').includes('image/png'),
      `${icon}: expected image/png`,
    )
  }

  const missingApi = await get('/api/nope')
  assert(missingApi.status === 404, `/api/nope: expected 404, got ${missingApi.status}`)
  assert(
    (missingApi.headers.get('content-type') ?? '').includes('application/json'),
    '/api/nope: expected JSON, not the SPA shell',
  )
}

async function main() {
  if (!existsSync(`${ROOT}dist/client/index.html`)) {
    console.error('dist/client/index.html is missing; run `pnpm build` first')
    process.exit(1)
  }

  await check(
    'build output has the client, service worker, and generated wrangler config',
    checkBuildOutput,
  )

  backupDevVars()
  child = startPreview()

  try {
    await waitForHealth()
    pass('vite preview is healthy')

    await checkPreview()
    pass('SPA fallback, Worker routes, service worker, manifest, and icons stay separate')
  } finally {
    await cleanup()
  }

  if (failures.length > 0) {
    console.error(`\n--- vite preview output ---\n${serverLog}`)
    console.error(`\n${passed} passed, ${failures.length} failed`)
    for (const failure of failures) console.error(`  - ${failure.label}: ${failure.detail}`)
    process.exit(1)
  }

  console.log(`\n${passed} checks passed`)
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
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  await cleanup()
  process.exit(1)
}
