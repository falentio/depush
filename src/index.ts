import { Hono } from 'hono'
import { verifyRequest } from './auth'
import type { AppConfig } from './config'
import { readConfig } from './config'
import type { AppBindings } from './env'
import { parseTrigger } from './events'
import { isWebSocketUpgrade, upgradeRejected } from './protocol'

export { AppHub } from './hub'

const PROTOCOL_VERSION = '7'
const PUSHER_ERROR_NO_APP = 4001
const PUSHER_ERROR_PATH_NOT_FOUND = 4005
const PUSHER_ERROR_UNSUPPORTED_PROTOCOL = 4007
const PUSHER_ERROR_NO_PROTOCOL = 4008

type HandshakeRejection = {
  code: number
  message: string
}

const app = new Hono<{ Bindings: AppBindings }>()

app.get('/healthz', (c) => c.json({ status: 'ok' }))

app.get('/app/:key', (c) => {
  const config = readConfig(c.env)
  const rejection = handshakeRejection(c.req.param('key'), c.req.query('protocol'), config)
  if (rejection !== null) {
    return upgradeRejected(c.req.raw, rejection.code, rejection.message)
  }

  return c.env.APP_HUB.get(c.env.APP_HUB.idFromName(config.appId)).fetch(c.req.raw)
})

app.post('/apps/:appId/events', async (c) => {
  const config = readConfig(c.env)
  if (c.req.param('appId') !== config.appId) {
    return c.json({ error: 'Invalid app id' }, 401)
  }

  const body = new Uint8Array(await c.req.raw.arrayBuffer())
  const auth = await verifyRequest(c.req.raw, body, config, Math.floor(Date.now() / 1000))
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status)
  }

  const parsed = parseTrigger(body)
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, parsed.status)
  }

  await c.env.APP_HUB.get(c.env.APP_HUB.idFromName(config.appId)).broadcast({
    name: parsed.trigger.name,
    data: parsed.trigger.data,
    channels: parsed.trigger.channels,
    exceptSocketId: parsed.trigger.socketId,
  })

  return c.json({})
})

app.notFound((c) => {
  if (isWebSocketUpgrade(c.req.raw)) {
    return upgradeRejected(c.req.raw, PUSHER_ERROR_PATH_NOT_FOUND, 'Path not found')
  }
  return c.json({ error: 'Not found' }, 404)
})

function handshakeRejection(
  key: string,
  protocol: string | undefined,
  config: AppConfig,
): HandshakeRejection | null {
  if (key !== config.key) {
    return { code: PUSHER_ERROR_NO_APP, message: 'Application does not exist' }
  }
  if (protocol === undefined) {
    return { code: PUSHER_ERROR_NO_PROTOCOL, message: 'No protocol version supplied' }
  }
  if (protocol !== PROTOCOL_VERSION) {
    return { code: PUSHER_ERROR_UNSUPPORTED_PROTOCOL, message: 'Unsupported protocol version' }
  }
  return null
}

export default app
