import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import * as v from 'valibot'
import type { AppBindings } from './env'
import type { Registry } from './registry'
import { createAuth } from './session'

type AdminEnv = {
  Bindings: AppBindings
  Variables: { registry: DurableObjectStub<Registry> }
}

/** Where better-auth's own endpoints live; the admin API sits beside them. */
export const AUTH_BASE_PATH = '/api/auth'

const createAppSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
})

const settingsSchema = v.object({
  signup_enabled: v.boolean(),
})

export const adminRoutes = new Hono<AdminEnv>()

adminRoutes.use('*', async (c, next) => {
  c.set('registry', c.env.REGISTRY.get(c.env.REGISTRY.idFromName('registry')))
  await next()
})

adminRoutes.all(`${AUTH_BASE_PATH}/*`, async (c) => {
  const auth = createAuth(c.var.registry, c.env, c.req.raw)
  return auth.handler(c.req.raw)
})

adminRoutes.get('/api/settings', ...adminOnly(async (c) => c.json(await c.var.registry.settings())))

adminRoutes.patch(
  '/api/settings',
  ...adminOnly(async (c) => {
    const body = await readJson(c)
    if (body === null) return c.json({ error: 'Invalid JSON body' }, 400)
    const parsed = v.safeParse(settingsSchema, body)
    if (!parsed.success) return c.json({ error: 'signup_enabled must be a boolean' }, 400)
    return c.json(await c.var.registry.updateSettings(parsed.output))
  }),
)

adminRoutes.get('/api/apps', ...adminOnly(async (c) => c.json(await c.var.registry.apps())))

adminRoutes.post(
  '/api/apps',
  ...adminOnly(async (c) => {
    const body = await readJson(c)
    if (body === null) return c.json({ error: 'Invalid JSON body' }, 400)
    const parsed = v.safeParse(createAppSchema, body)
    if (!parsed.success) return c.json({ error: 'name must be 1-100 characters' }, 400)

    const created = await c.var.registry.createApp(parsed.output.name)
    if (created === null) return c.json({ error: 'Could not allocate an app id' }, 500)
    return c.json(created, 201)
  }),
)

adminRoutes.patch(
  '/api/apps/:appId',
  ...adminOnly(async (c) => {
    const body = await readJson(c)
    if (body === null) return c.json({ error: 'Invalid JSON body' }, 400)
    const parsed = v.safeParse(createAppSchema, body)
    if (!parsed.success) return c.json({ error: 'name must be 1-100 characters' }, 400)

    const updated = await c.var.registry.updateApp(c.req.param('appId') ?? '', parsed.output.name)
    if (updated === null) return c.json({ error: 'App not found' }, 404)
    return c.json(updated)
  }),
)

adminRoutes.get(
  '/api/apps/:appId',
  ...adminOnly(async (c) => {
    const found = await c.var.registry.appById(c.req.param('appId') ?? '')
    if (found === null) return c.json({ error: 'App not found' }, 404)
    const { id, key, name, created_at } = found
    return c.json({ id, key, name, created_at })
  }),
)

adminRoutes.delete(
  '/api/apps/:appId',
  ...adminOnly(async (c) => {
    const deleted = await c.var.registry.deleteApp(c.req.param('appId') ?? '')
    if (!deleted) return c.json({ error: 'App not found' }, 404)
    return c.body(null, 204)
  }),
)

/**
 * A valid better-auth session is the first half of the gate; the role column is
 * the second, so an account without a role never inherits admin.
 */
function adminOnly(
  handler: (c: Context<AdminEnv>) => Response | Promise<Response>,
): [MiddlewareHandler<AdminEnv>, (c: Context<AdminEnv>) => Promise<Response>] {
  return [
    async (c, next) => {
      const auth = createAuth(c.var.registry, c.env, c.req.raw)
      const session = await auth.api.getSession({ headers: c.req.raw.headers })
      if (session === null) return c.json({ error: 'Unauthorized' }, 401)
      if (session.user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
      await next()
    },
    async (c) => handler(c),
  ]
}

async function readJson(c: Context<AdminEnv>): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}
