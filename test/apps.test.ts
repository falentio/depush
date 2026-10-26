import { exports } from 'cloudflare:workers'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import type { App } from '../src/domain/app'
import { appSchema } from '../src/domain/app'

const baseUrl = 'https://depush.test'
const jsonHeaders = { 'content-type': 'application/json' }

const healthSchema = v.object({ status: v.literal('ok'), db: v.literal('up') })
const appEnvelopeSchema = v.object({ app: appSchema })
const appListSchema = v.object({ apps: v.array(appSchema) })
const notFoundErrorSchema = v.object({
  error: v.object({ code: v.literal('not_found'), message: v.string() }),
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

async function createTestApp(name: string): Promise<App> {
  const response = await exports.default.fetch(`${baseUrl}/apps`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name }),
  })
  expect(response.status).toBe(201)

  return v.parse(appEnvelopeSchema, await response.json()).app
}

describe('apps', () => {
  it('reports the database as up', async () => {
    const response = await exports.default.fetch(`${baseUrl}/health`)

    expect(response.status).toBe(200)
    expect(v.parse(healthSchema, await response.json())).toEqual({ status: 'ok', db: 'up' })
  })

  it('creates an app with a trimmed name', async () => {
    const response = await exports.default.fetch(`${baseUrl}/apps`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ name: '  deploy bot  ' }),
    })

    expect(response.status).toBe(201)
    const { app } = v.parse(appEnvelopeSchema, await response.json())
    expect(app.name).toBe('deploy bot')
    expect(app.id).toHaveLength(36)
    expect(app.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('lists apps newest first', async () => {
    const older = await createTestApp('older')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const newer = await createTestApp('newer')

    const response = await exports.default.fetch(`${baseUrl}/apps`)
    expect(response.status).toBe(200)

    const { apps } = v.parse(appListSchema, await response.json())
    expect(apps[0]?.id).toBe(newer.id)
    expect(apps.map((app) => app.id)).toContain(older.id)
  })

  it.each([
    { case: 'missing', body: {} },
    { case: 'blank', body: { name: '   ' } },
    { case: 'too long', body: { name: 'x'.repeat(81) } },
  ])('rejects a $case name', async ({ body }) => {
    const response = await exports.default.fetch(`${baseUrl}/apps`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    })

    expect(response.status).toBe(400)
    const parsed = v.parse(validationErrorSchema, await response.json())
    expect(parsed.error.code).toBe('validation')
    expect(parsed.error.details.issues.some((issue) => issue.path === 'name')).toBe(true)
  })

  it('returns the error envelope for an unknown route', async () => {
    const response = await exports.default.fetch(`${baseUrl}/missing-route`)

    expect(response.status).toBe(404)
    expect(v.parse(notFoundErrorSchema, await response.json()).error.code).toBe('not_found')
  })
})
