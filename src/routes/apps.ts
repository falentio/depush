import { Hono } from 'hono'
import { createApp, listApps } from '../data/apps'
import { createDb } from '../db/client'
import { createAppSchema } from '../domain/app'
import { validate } from '../http/validation'

export const appsRoutes = new Hono<{ Bindings: Env }>()
  .get('/', async (c) => {
    const db = createDb(c.env.DB)
    const apps = await listApps(db)
    return c.json({ apps })
  })
  .post('/', validate('json', createAppSchema), async (c) => {
    const db = createDb(c.env.DB)
    const app = await createApp(db, c.req.valid('json'))
    return c.json({ app }, 201)
  })
