import { Hono } from 'hono'
import { createApp, listApps } from '../data/apps'
import { createAppSchema } from '../domain/app'
import { validate } from '../http/validation'

export const appsRoutes = new Hono<{ Bindings: Env }>()
  .get('/', async (c) => {
    const apps = await listApps(c.env.DB)
    return c.json({ apps })
  })
  .post('/', validate('json', createAppSchema), async (c) => {
    const app = await createApp(c.env.DB, c.req.valid('json'))
    return c.json({ app }, 201)
  })
