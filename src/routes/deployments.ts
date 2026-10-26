import { Hono } from 'hono'
import * as v from 'valibot'
import { requireApp } from '../data/apps'
import { createDeployment, listDeployments, transitionDeployment } from '../data/deployments'
import {
  createDeploymentSchema,
  toDeploymentEvent,
  transitionDeploymentSchema,
} from '../domain/deployment'
import { appChannel } from '../durable/app-channel'
import { decodeCursor } from '../http/pagination'
import { parseId, validate } from '../http/validation'

const listQuerySchema = v.object({
  limit: v.optional(
    v.pipe(v.string(), v.digits(), v.toNumber(), v.integer(), v.minValue(1), v.maxValue(100)),
  ),
  cursor: v.optional(v.pipe(v.string(), v.minLength(1))),
})

export const deploymentRoutes = new Hono<{ Bindings: Env }>()
  .get('/:appId/deployments', validate('query', listQuerySchema), async (c) => {
    const appId = parseId(c.req.param('appId'))
    const { limit, cursor } = c.req.valid('query')
    await requireApp(c.env.DB, appId)

    const page = await listDeployments(c.env.DB, appId, {
      limit: limit ?? 50,
      cursor: cursor === undefined ? null : decodeCursor(cursor),
    })
    return c.json(page)
  })
  .post('/:appId/deployments', validate('json', createDeploymentSchema), async (c) => {
    const appId = parseId(c.req.param('appId'))
    const input = c.req.valid('json')
    await requireApp(c.env.DB, appId)

    const { deployment, created } = await createDeployment(c.env.DB, appId, {
      id: input.id ?? crypto.randomUUID(),
      commitSha: input.commitSha,
      status: input.status,
    })
    await appChannel(c.env, appId).publish(toDeploymentEvent(deployment))

    return c.json({ deployment }, created ? 201 : 200)
  })
  .patch(
    '/:appId/deployments/:deploymentId',
    validate('json', transitionDeploymentSchema),
    async (c) => {
      const appId = parseId(c.req.param('appId'))
      const deploymentId = parseId(c.req.param('deploymentId'))
      const { status } = c.req.valid('json')

      const deployment = await transitionDeployment(c.env.DB, appId, deploymentId, status)
      await appChannel(c.env, appId).publish(toDeploymentEvent(deployment))

      return c.json({ deployment })
    },
  )
