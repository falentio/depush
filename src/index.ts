import type { Context } from 'hono'
import { Hono } from 'hono'
import { verifyRequest } from './auth'
import { readBodyCapped } from './body'
import type { AppConfig } from './config'
import { readConfig } from './config'
import type { AppBindings } from './env'
import {
  channelInfo,
  channelList,
  channelUsers,
  parseBatch,
  parseChannelInfo,
  parseTrigger,
} from './events'
import { isValidChannelName, isWebSocketUpgrade, upgradeRejected } from './protocol'

export { AppHub } from './hub'

const PROTOCOL_VERSION = '7'
const PUSHER_ERROR_NO_APP = 4001
const PUSHER_ERROR_PATH_NOT_FOUND = 4005
const PUSHER_ERROR_UNSUPPORTED_PROTOCOL = 4007
const PUSHER_ERROR_NO_PROTOCOL = 4008

type AppContext = Context<{ Bindings: AppBindings }>

type HandshakeRejection = {
  code: number
  message: string
}

type SignedRequest =
  | { ok: true; config: AppConfig; body: Uint8Array }
  | { ok: false; response: Response }

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
  const signed = await signedRequest(c)
  if (!signed.ok) return signed.response

  const parsed = parseTrigger(signed.body, c.req.query('info'))
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, parsed.status)
  }

  await appHub(c, signed.config).broadcast({
    name: parsed.trigger.name,
    data: parsed.trigger.data,
    channels: parsed.trigger.channels,
    exceptSocketId: parsed.trigger.socketId,
  })

  return c.json({})
})

app.post('/apps/:appId/batch_events', async (c) => {
  const signed = await signedRequest(c)
  if (!signed.ok) return signed.response

  const parsed = parseBatch(signed.body)
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, parsed.status)
  }

  const hub = appHub(c, signed.config)
  for (const event of parsed.events) {
    await hub.broadcast({
      name: event.name,
      data: event.data,
      channels: [event.channel],
      exceptSocketId: event.socketId,
    })
  }

  return c.json({})
})

app.get('/apps/:appId/channels', async (c) => {
  const signed = await signedRequest(c)
  if (!signed.ok) return signed.response

  const info = parseChannelInfo(c.req.query('info'))
  if (!info.ok) return c.json({ error: info.error }, 400)

  const prefix = c.req.query('filter_by_prefix')
  if (prefix !== undefined && !isValidChannelName(prefix)) {
    return c.json({ error: 'Invalid channel name' }, 400)
  }

  const snapshot = await appHub(c, signed.config).channelSnapshot()
  const result = channelList(snapshot, prefix, info.info)
  if (!result.ok) return c.json({ error: result.error }, 400)

  return c.json(result.body)
})

app.get('/apps/:appId/channels/:channelName/users', async (c) => {
  const signed = await signedRequest(c)
  if (!signed.ok) return signed.response

  const channelName = c.req.param('channelName')
  if (!isValidChannelName(channelName)) {
    return c.json({ error: 'Invalid channel name' }, 400)
  }

  const snapshot = await appHub(c, signed.config).channelSnapshot()
  const result = channelUsers(snapshot, channelName)
  if (!result.ok) return c.json({ error: result.error }, 400)

  return c.json(result.body)
})

app.get('/apps/:appId/channels/:channelName', async (c) => {
  const signed = await signedRequest(c)
  if (!signed.ok) return signed.response

  const channelName = c.req.param('channelName')
  if (!isValidChannelName(channelName)) {
    return c.json({ error: 'Invalid channel name' }, 400)
  }

  const info = parseChannelInfo(c.req.query('info'))
  if (!info.ok) return c.json({ error: info.error }, 400)

  const snapshot = await appHub(c, signed.config).channelSnapshot()
  const result = channelInfo(snapshot, channelName, info.info)
  if (!result.ok) return c.json({ error: result.error }, 400)

  return c.json(result.body)
})

app.notFound((c) => {
  if (isWebSocketUpgrade(c.req.raw)) {
    return upgradeRejected(c.req.raw, PUSHER_ERROR_PATH_NOT_FOUND, 'Path not found')
  }
  return c.json({ error: 'Not found' }, 404)
})

function appHub(c: AppContext, config: AppConfig) {
  return c.env.APP_HUB.get(c.env.APP_HUB.idFromName(config.appId))
}

async function signedRequest(c: AppContext): Promise<SignedRequest> {
  const capped = await readBodyCapped(c.req.raw)
  if (!capped.ok) {
    return { ok: false, response: c.json({ error: 'Request body exceeds 256KB' }, 413) }
  }

  const config = readConfig(c.env)
  if (c.req.param('appId') !== config.appId) {
    return { ok: false, response: c.json({ error: 'Invalid app id' }, 401) }
  }

  const auth = await verifyRequest(c.req.raw, capped.body, config, Math.floor(Date.now() / 1000))
  if (!auth.ok) {
    return { ok: false, response: c.json({ error: auth.error }, auth.status) }
  }

  return { ok: true, config, body: capped.body }
}

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
