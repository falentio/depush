import { exports } from 'cloudflare:workers'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import type { App } from '../src/domain/app'
import { appSchema } from '../src/domain/app'
import type { Deployment } from '../src/domain/deployment'
import { deploymentEventSchema, deploymentSchema } from '../src/domain/deployment'

const baseUrl = 'https://depush.test'
const jsonHeaders = { 'content-type': 'application/json' }

const appEnvelopeSchema = v.object({ app: appSchema })
const deploymentEnvelopeSchema = v.object({ deployment: deploymentSchema })
const deploymentPageSchema = v.object({
  deployments: v.array(deploymentSchema),
  nextCursor: v.nullable(v.string()),
})
const liveSchema = v.object({
  live: v.object({
    sequence: v.number(),
    latest: v.nullable(deploymentEventSchema),
  }),
})
const notFoundErrorSchema = v.object({
  error: v.object({ code: v.literal('not_found'), message: v.string() }),
})

async function createTestApp(): Promise<App> {
  const response = await exports.default.fetch(`${baseUrl}/apps`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name: 'live' }),
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

async function createdDeployment(appId: string, body: unknown): Promise<Deployment> {
  const response = await postDeployment(appId, body)
  expect(response.status).toBe(201)

  return v.parse(deploymentEnvelopeSchema, await response.json()).deployment
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

async function readLive(appId: string): Promise<v.InferOutput<typeof liveSchema>['live']> {
  const response = await exports.default.fetch(`${baseUrl}/apps/${appId}/live`)
  expect(response.status).toBe(200)

  return v.parse(liveSchema, await response.json()).live
}

async function readDeploymentCount(appId: string): Promise<number> {
  const response = await exports.default.fetch(`${baseUrl}/apps/${appId}/deployments`)
  const page = v.parse(deploymentPageSchema, await response.json())
  return page.deployments.length
}

describe('live channel', () => {
  it('publishes a snapshot when a deployment is created', async () => {
    const app = await createTestApp()
    const deployment = await createdDeployment(app.id, { commitSha: 'abcdef1' })

    const live = await readLive(app.id)

    expect(live.sequence).toBe(1)
    expect(live.latest?.id).toBe(deployment.id)
    expect(live.latest?.status).toBe('queued')
    expect(live.latest?.at).toBe(deployment.updatedAt)
  })

  it('publishes on transition and again on a replayed create', async () => {
    const app = await createTestApp()
    const deployment = await createdDeployment(app.id, { id: 'live-1', commitSha: 'abcdef1' })

    const transition = await patchDeployment(app.id, deployment.id, { status: 'building' })
    expect(transition.status).toBe(200)

    const afterTransition = await readLive(app.id)
    expect(afterTransition.sequence).toBe(2)
    expect(afterTransition.latest?.status).toBe('building')

    const replay = await postDeployment(app.id, { id: 'live-1', commitSha: 'abcdef1' })
    expect(replay.status).toBe(200)

    const afterReplay = await readLive(app.id)
    expect(afterReplay.sequence).toBe(3)
    expect(afterReplay.latest?.status).toBe('building')
    expect(await readDeploymentCount(app.id)).toBe(1)
  })

  it('returns 404 for the live state of an unknown app', async () => {
    const response = await exports.default.fetch(`${baseUrl}/apps/${crypto.randomUUID()}/live`)

    expect(response.status).toBe(404)
    expect(v.parse(notFoundErrorSchema, await response.json()).error.code).toBe('not_found')
  })

  it('rejects a socket request that is not an upgrade', async () => {
    const app = await createTestApp()

    const response = await exports.default.fetch(`${baseUrl}/apps/${app.id}/live/ws`)

    expect(response.status).toBe(426)
  })
})
