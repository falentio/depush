import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import * as v from 'valibot'
import type { AppBindings } from './env'
import { log } from './logging'
import type { Registry } from './registry'
import { publicApp, registryStub } from './registry'
import { createAuth } from './session'

type AdminEnv = {
  Bindings: AppBindings
  Variables: { registry: DurableObjectStub<Registry>; userId: string }
}

const createAppSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
})

const settingsSchema = v.object({
  signup_enabled: v.boolean(),
})

/**
 * Mounted under `/api`, so `/auth/*` is better-auth's `/api/auth/*` and the
 * routes below sit beside it.
 */
export const adminRoutes = new Hono<AdminEnv>()

adminRoutes.use('*', async (c, next) => {
  c.set('registry', registryStub(c.env))
  await next()
})

adminRoutes.all('/auth/*', async (c) => {
  const auth = createAuth(c.var.registry, c.env, c.req.raw)
  return auth.handler(c.req.raw)
})

adminRoutes.get('/settings', ...adminOnly(async (c) => c.json(await c.var.registry.settings())))

adminRoutes.patch(
  '/settings',
  ...adminOnly(async (c) => {
    const body = await readJson(c)
    if (body === null) return c.json({ error: 'Invalid JSON body' }, 400)
    const parsed = v.safeParse(settingsSchema, body)
    if (!parsed.success) return c.json({ error: 'signup_enabled must be a boolean' }, 400)
    const updated = await c.var.registry.updateSettings(parsed.output)
    log.admin.info('settings_updated', {
      userId: c.var.userId,
      signupEnabled: parsed.output.signup_enabled,
    })
    return c.json(updated)
  }),
)

adminRoutes.get('/apps', ...adminOnly(async (c) => c.json(await c.var.registry.apps())))

adminRoutes.post(
  '/apps',
  ...adminOnly(async (c) => {
    const body = await readJson(c)
    if (body === null) return c.json({ error: 'Invalid JSON body' }, 400)
    const parsed = v.safeParse(createAppSchema, body)
    if (!parsed.success) return c.json({ error: 'name must be 1-100 characters' }, 400)

    const created = await c.var.registry.createApp(parsed.output.name)
    if (created === null) return c.json({ error: 'Could not allocate an app id' }, 500)
    log.admin.info('app_created', {
      userId: c.var.userId,
      appId: created.id,
      appName: created.name,
    })
    return c.json(created, 201)
  }),
)

adminRoutes.patch(
  '/apps/:appId',
  ...adminOnly(async (c) => {
    const body = await readJson(c)
    if (body === null) return c.json({ error: 'Invalid JSON body' }, 400)
    const parsed = v.safeParse(createAppSchema, body)
    if (!parsed.success) return c.json({ error: 'name must be 1-100 characters' }, 400)

    const updated = await c.var.registry.updateApp(c.req.param('appId') ?? '', parsed.output.name)
    if (updated === null) return c.json({ error: 'App not found' }, 404)
    log.admin.info('app_updated', {
      userId: c.var.userId,
      appId: updated.id,
      appName: updated.name,
    })
    return c.json(updated)
  }),
)

adminRoutes.get(
  '/apps/:appId',
  ...adminOnly(async (c) => {
    const found = await c.var.registry.appById(c.req.param('appId') ?? '')
    if (found === null) return c.json({ error: 'App not found' }, 404)
    return c.json(publicApp(found))
  }),
)

adminRoutes.delete(
  '/apps/:appId',
  ...adminOnly(async (c) => {
    const appId = c.req.param('appId') ?? ''
    const deleted = await c.var.registry.deleteApp(appId)
    if (!deleted) return c.json({ error: 'App not found' }, 404)
    log.admin.info('app_deleted', { userId: c.var.userId, appId })
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
      if (session === null) {
        log.admin.debug('denied', { path: c.req.path, status: 401 })
        return c.json({ error: 'Unauthorized' }, 401)
      }
      if (session.user.role !== 'admin') {
        log.admin.warn('denied', { path: c.req.path, userId: session.user.id, status: 403 })
        return c.json({ error: 'Forbidden' }, 403)
      }
      c.set('userId', session.user.id)
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
