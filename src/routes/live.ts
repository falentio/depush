import { Hono } from 'hono'
import { requireApp } from '../data/apps'
import { createDb } from '../db/client'
import { appChannel } from '../durable/app-channel'
import { parseId } from '../http/validation'

export const liveRoutes = new Hono<{ Bindings: Env }>()
  .get('/:appId/live', async (c) => {
    const db = createDb(c.env.DB)
    const appId = parseId(c.req.param('appId'))
    await requireApp(db, appId)

    const live = await appChannel(c.env, appId).snapshot()
    return c.json({ live })
  })
  .get('/:appId/live/ws', async (c) => {
    const db = createDb(c.env.DB)
    const appId = parseId(c.req.param('appId'))
    await requireApp(db, appId)
    return appChannel(c.env, appId).fetch(c.req.raw)
  })
