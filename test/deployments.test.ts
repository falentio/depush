import { exports } from 'cloudflare:workers'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import type { App } from '../src/domain/app'
import { appSchema } from '../src/domain/app'
import type { Deployment } from '../src/domain/deployment'
import { deploymentSchema, deploymentStatusSchema } from '../src/domain/deployment'

const baseUrl = 'https://depush.test'
const jsonHeaders = { 'content-type': 'application/json' }

const appEnvelopeSchema = v.object({ app: appSchema })
const deploymentEnvelopeSchema = v.object({ deployment: deploymentSchema })
const deploymentPageSchema = v.object({
  deployments: v.array(deploymentSchema),
  nextCursor: v.nullable(v.string()),
})
const conflictErrorSchema = v.object({
  error: v.object({
    code: v.literal('conflict'),
    message: v.string(),
    details: v.object({ from: deploymentStatusSchema, to: deploymentStatusSchema }),
  }),
})
const notFoundErrorSchema = v.object({
  error: v.object({ code: v.literal('not_found'), message: v.string() }),
})
const conflictCodeSchema = v.object({
  error: v.object({ code: v.literal('conflict'), message: v.string() }),
})
const validationErrorSchema = v.object({
  error: v.object({
    code: v.literal('validation'),
    message: v.string(),
    details: v.object({
      issues: v.array(v.object({ path: v.string(), message: v.string() })),
    }),
  }),
})

async function createTestApp(name = 'api'): Promise<App> {
  const response = await exports.default.fetch(`${baseUrl}/apps`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name }),
  })
  expect(response.status).toBe(201)

  return v.parse(appEnvelopeSchema, await response.json()).app
}

async function postDeployment(appId: string, body: unknown): Promise<Response> {
  return await exports.default.fetch(`${baseUrl}/apps/${appId}/deployments`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  })
}

async function patchDeployment(
  appId: string,
  deploymentId: string,
  body: unknown,
): Promise<Response> {
  return await exports.default.fetch(`${baseUrl}/apps/${appId}/deployments/${deploymentId}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  })
}

async function createdDeployment(appId: string, body: unknown): Promise<Deployment> {
  const response = await postDeployment(appId, body)
  expect(response.status).toBe(201)

  return v.parse(deploymentEnvelopeSchema, await response.json()).deployment
}

async function readDeploymentPage(
  appId: string,
  query = '',
): Promise<v.InferOutput<typeof deploymentPageSchema>> {
  const response = await exports.default.fetch(`${baseUrl}/apps/${appId}/deployments${query}`)
  expect(response.status).toBe(200)

  return v.parse(deploymentPageSchema, await response.json())
}

describe('deployments', () => {
  it('defaults a new deployment to queued', async () => {
    const app = await createTestApp()
    const response = await postDeployment(app.id, { commitSha: 'abcdef1' })

    expect(response.status).toBe(201)
    const { deployment } = v.parse(deploymentEnvelopeSchema, await response.json())
    expect(deployment.status).toBe('queued')
    expect(deployment.appId).toBe(app.id)
    expect(deployment.commitSha).toBe('abcdef1')
  })

  it('replays an existing id without inserting a second row', async () => {
    const app = await createTestApp()
    const created = await createdDeployment(app.id, { id: 'deploy-1', commitSha: 'abcdef1' })

    const replay = await postDeployment(app.id, { id: 'deploy-1', commitSha: 'abcdef1' })
    expect(replay.status).toBe(200)
    const replayed = v.parse(deploymentEnvelopeSchema, await replay.json()).deployment
    expect(replayed.id).toBe(created.id)

    const page = await readDeploymentPage(app.id)
    expect(page.deployments).toHaveLength(1)
  })

  it('rejects a reused id owned by another app', async () => {
    const first = await createTestApp('first')
    const second = await createTestApp('second')
    await createdDeployment(first.id, { id: 'shared', commitSha: 'abcdef1' })

    const response = await postDeployment(second.id, { id: 'shared', commitSha: 'abcdef1' })

    expect(response.status).toBe(409)
    expect(v.parse(conflictCodeSchema, await response.json()).error.code).toBe('conflict')
  })

  it('rejects an invalid commit sha', async () => {
    const app = await createTestApp()

    const response = await postDeployment(app.id, { commitSha: 'not-a-sha' })

    expect(response.status).toBe(400)
    const parsed = v.parse(validationErrorSchema, await response.json())
    expect(parsed.error.details.issues.some((issue) => issue.path === 'commitSha')).toBe(true)
  })

  it('moves queued to building to ready', async () => {
    const app = await createTestApp()
    const created = await createdDeployment(app.id, { commitSha: 'abcdef1' })

    const building = await patchDeployment(app.id, created.id, { status: 'building' })
    expect(building.status).toBe(200)
    expect(v.parse(deploymentEnvelopeSchema, await building.json()).deployment.status).toBe(
      'building',
    )

    const ready = await patchDeployment(app.id, created.id, { status: 'ready' })
    expect(ready.status).toBe(200)
    expect(v.parse(deploymentEnvelopeSchema, await ready.json()).deployment.status).toBe('ready')
  })

  it('rejects a transition out of ready with both statuses in details', async () => {
    const app = await createTestApp()
    const created = await createdDeployment(app.id, { commitSha: 'abcdef1' })
    await patchDeployment(app.id, created.id, { status: 'building' })
    await patchDeployment(app.id, created.id, { status: 'ready' })

    const response = await patchDeployment(app.id, created.id, { status: 'failed' })

    expect(response.status).toBe(409)
    const { error } = v.parse(conflictErrorSchema, await response.json())
    expect(error.details.from).toBe('ready')
    expect(error.details.to).toBe('failed')
  })

  it('returns 404 when creating against an unknown app', async () => {
    const response = await postDeployment(crypto.randomUUID(), { commitSha: 'abcdef1' })

    expect(response.status).toBe(404)
    expect(v.parse(notFoundErrorSchema, await response.json()).error.code).toBe('not_found')
  })

  it('returns 404 when patching an unknown deployment', async () => {
    const app = await createTestApp()

    const response = await patchDeployment(app.id, 'missing-deployment', { status: 'building' })

    expect(response.status).toBe(404)
    expect(v.parse(notFoundErrorSchema, await response.json()).error.code).toBe('not_found')
  })

  it('rejects an invalid limit', async () => {
    const app = await createTestApp()

    for (const limit of ['0', '101', 'abc']) {
      const response = await exports.default.fetch(
        `${baseUrl}/apps/${app.id}/deployments?limit=${limit}`,
      )

      expect(response.status, `limit=${limit}`).toBe(400)
      const parsed = v.parse(validationErrorSchema, await response.json())
      expect(parsed.error.code).toBe('validation')
    }
  })

  it('rejects a malformed cursor', async () => {
    const app = await createTestApp()

    const response = await exports.default.fetch(
      `${baseUrl}/apps/${app.id}/deployments?cursor=not-a-cursor`,
    )

    expect(response.status).toBe(400)
    const parsed = v.parse(validationErrorSchema, await response.json())
    expect(parsed.error.code).toBe('validation')
  })

  it('paginates newest first with an opaque cursor', async () => {
    const app = await createTestApp()
    const ids: string[] = []
    for (const id of ['one', 'two', 'three']) {
      const deployment = await createdDeployment(app.id, { id, commitSha: 'abcdef1' })
      ids.push(deployment.id)
    }

    const first = await readDeploymentPage(app.id, '?limit=2')
    expect(first.deployments).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    if (first.nextCursor === null) throw new Error('Expected a next cursor')

    const second = await readDeploymentPage(
      app.id,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
    )
    expect(second.deployments).toHaveLength(1)
    expect(second.nextCursor).toBeNull()

    const seen = [...first.deployments, ...second.deployments].map((deployment) => deployment.id)
    expect(new Set(seen)).toEqual(new Set(ids))
  })
})
