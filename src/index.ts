import type { Context } from 'hono'
import { Hono } from 'hono'
import { adminRoutes } from './admin'
import { verifyRequest } from './auth'
import { readBodyCapped } from './body'
import type { AppConfig } from './config'
import { appConfig, readSettings } from './config'
import type { AppBindings } from './env'
import {
  channelInfo,
  channelList,
  channelUsers,
  parseBatch,
  parseChannelInfo,
  parseHistoryQuery,
  parseTrigger,
} from './events'
import {
  channelKind,
  isCacheChannel,
  isValidChannelName,
  isWebSocketUpgrade,
  upgradeRejected,
} from './protocol'

export { Channel } from './channel'
export { AppHub } from './hub'
export { Registry } from './registry'

const PROTOCOL_VERSION = '7'
const PUSHER_ERROR_NO_APP = 4001
const PUSHER_ERROR_PATH_NOT_FOUND = 4005
const PUSHER_ERROR_UNSUPPORTED_PROTOCOL = 4007
const PUSHER_ERROR_NO_PROTOCOL = 4008
const PRESENCE_ONLY = 'presence is only available for presence channels'

type AppContext = Context<{ Bindings: AppBindings }>

type HandshakeRejection = {
  code: number
  message: string
}

type SignedRequest =
  | { ok: true; config: AppConfig; body: Uint8Array }
  | { ok: false; response: Response }

const app = new Hono<{ Bindings: AppBindings }>()

app.route('/', adminRoutes)

app.get('/healthz', (c) => c.json({ status: 'ok' }))

app.get('/app/:key', async (c) => {
  const found = await registry(c).appByKey(c.req.param('key'))
  if (found === null) {
    return upgradeRejected(c.req.raw, PUSHER_ERROR_NO_APP, 'Application does not exist')
  }

  const rejection = handshakeRejection(c.req.query('protocol'))
  if (rejection !== null) {
    return upgradeRejected(c.req.raw, rejection.code, rejection.message)
  }

  const config = appConfig(found, readSettings(c.env))
  const hub = c.env.APP_HUB.get(c.env.APP_HUB.idFromName(config.appId))
  await hub.init(config)
  return hub.fetch(c.req.raw)
})

app.post('/apps/:appId/events', async (c) => {
  const signed = await signedRequest(c)
  if (!signed.ok) return signed.response

  const parsed = parseTrigger(signed.body, c.req.query('info'))
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, parsed.status)
  }

  const hub = appHub(c, signed.config)
  await hub.broadcast({
    name: parsed.trigger.name,
    data: parsed.trigger.data,
    channels: parsed.trigger.channels,
    userId: null,
    cache: true,
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
      userId: null,
      cache: true,
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
  if (prefix !== undefined && prefix !== '' && !isValidChannelName(prefix)) {
    return c.json({ error: 'Invalid channel name' }, 400)
  }

  const hub = appHub(c, signed.config)
  const snapshot = await hub.channelSnapshot()
  const result = channelList(snapshot, prefix === '' ? undefined : prefix, info.info)
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

  const hub = appHub(c, signed.config)
  const snapshot = await hub.channelSnapshot()
  const result = channelUsers(snapshot, channelName)
  if (!result.ok) return c.json({ error: result.error }, 400)

  return c.json(result.body)
})

app.get('/apps/:appId/channels/:channelName/history', async (c) => {
  const signed = await signedRequest(c)
  if (!signed.ok) return signed.response

  const channelName = c.req.param('channelName')
  if (!isValidChannelName(channelName)) {
    return c.json({ error: 'Invalid channel name' }, 400)
  }

  const parsed = parseHistoryQuery(c.req.query('limit'), c.req.query('before'))
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  return c.json(await channelState(c, signed.config, channelName).history(parsed.query))
})

app.get('/apps/:appId/channels/:channelName/presence', async (c) => {
  const signed = await signedRequest(c)
  if (!signed.ok) return signed.response

  const channelName = c.req.param('channelName')
  if (!isValidChannelName(channelName)) {
    return c.json({ error: 'Invalid channel name' }, 400)
  }
  if (channelKind(channelName) !== 'presence') {
    return c.json({ error: PRESENCE_ONLY }, 400)
  }

  const hub = appHub(c, signed.config)
  const presence = await hub.presenceInfo(channelName)
  if (presence === null) return c.json({ error: PRESENCE_ONLY }, 400)

  return c.json({ presence })
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

  if (info.info.cache && !isCacheChannel(channelName)) {
    return c.json({ error: 'cache is only available on cache channels' }, 400)
  }

  const hub = appHub(c, signed.config)
  const snapshot = await hub.channelSnapshot()
  const result = channelInfo(snapshot, channelName, info.info)
  if (!result.ok) return c.json({ error: result.error }, 400)

  if (!info.info.cache) return c.json(result.body)

  const cache = await channelState(c, signed.config, channelName).cacheInfo()
  return c.json({ ...result.body, cache })
})

app.notFound((c) => {
  if (isWebSocketUpgrade(c.req.raw)) {
    return upgradeRejected(c.req.raw, PUSHER_ERROR_PATH_NOT_FOUND, 'Path not found')
  }
  return c.json({ error: 'Not found' }, 404)
})

function registry(c: AppContext) {
  return c.env.REGISTRY.get(c.env.REGISTRY.idFromName('registry'))
}

function appHub(c: AppContext, config: AppConfig) {
  return c.env.APP_HUB.get(c.env.APP_HUB.idFromName(config.appId))
}

function channelState(c: AppContext, config: AppConfig, channel: string) {
  return c.env.CHANNEL.get(c.env.CHANNEL.idFromName(`${config.appId}:${channel}`))
}

async function signedRequest(c: AppContext): Promise<SignedRequest> {
  const capped = await readBodyCapped(c.req.raw)
  if (!capped.ok) {
    return { ok: false, response: c.json({ error: 'Request body exceeds 256KB' }, 413) }
  }

  const appId = c.req.param('appId')
  if (appId === undefined) {
    return { ok: false, response: c.json({ error: 'Invalid app id' }, 401) }
  }

  const found = await registry(c).appById(appId)
  if (found === null) {
    return { ok: false, response: c.json({ error: 'Invalid app id' }, 401) }
  }

  const config = appConfig(found, readSettings(c.env))

  const auth = await verifyRequest(c.req.raw, capped.body, config, Math.floor(Date.now() / 1000))
  if (!auth.ok) {
    return { ok: false, response: c.json({ error: auth.error }, auth.status) }
  }

  return { ok: true, config, body: capped.body }
}

function handshakeRejection(protocol: string | undefined): HandshakeRejection | null {
  if (protocol === undefined) {
    return { code: PUSHER_ERROR_NO_PROTOCOL, message: 'No protocol version supplied' }
  }
  if (protocol !== PROTOCOL_VERSION) {
    return { code: PUSHER_ERROR_UNSUPPORTED_PROTOCOL, message: 'Unsupported protocol version' }
  }
  return null
}

export default app
