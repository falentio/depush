import { Hono } from 'hono'
import * as v from 'valibot'
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
  const row = await c.env.DB.prepare('SELECT 1 AS ok').first()
  v.parse(healthSchema, row)
  return c.json({ status: 'ok', db: 'up' })
})

app.route('/apps', appsRoutes)
app.route('/apps', deploymentRoutes)
app.route('/apps', liveRoutes)

export default app
