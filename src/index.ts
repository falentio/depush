import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { createDb } from './db/client'
import { handleError, handleNotFound } from './http/errors'
import { appsRoutes } from './routes/apps'
import { deploymentRoutes } from './routes/deployments'
import { liveRoutes } from './routes/live'

export { AppChannel } from './durable/app-channel'

const healthSchema = v.object({ ok: v.number() })

const app = new Hono<{ Bindings: Env }>()

app.onError(handleError)
app.notFound(handleNotFound)

app.get('/health', async (c) => {
  const db = createDb(c.env.DB)
  const row = await db.get<{ ok: number }>(sql`select 1 as ok`)
  v.parse(healthSchema, row)
  return c.json({ status: 'ok', db: 'up' })
})

app.route('/apps', appsRoutes)
app.route('/apps', deploymentRoutes)
app.route('/apps', liveRoutes)

export default app
