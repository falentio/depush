import { createHash } from 'node:crypto'
import PusherServer, { type PusherResponse } from 'pusher'
import { describe, expect, it } from 'vitest'

const RUN_ID = `${Date.now().toString(36)}-${process.pid.toString(36)}`
const CLOUD_API_URL = 'https://api.pusherapp.com'

type Channels = {
  public: string
  cache: string
  presence: string
}

type LocalEnv = {
  baseUrl: string
  appId: string
  key: string
  secret: string
}

type CloudEnv = {
  appId: string
  key: string
  secret: string
}

type Observed = {
  status: number
  body: unknown
}

type ParityCase = {
  id: string
  expectedStatus: number
  expectedBody?: unknown
  compareBody: boolean
  assertBody?: (local: unknown, cloud: unknown) => void
  run: (client: PusherServer, channels: Channels) => Promise<PusherResponse>
}

type RequestError = {
  status: number
  body: string
}

type CacheInfo = {
  occupied: boolean
  cache: {
    data: string
    ttl: number
  }
}

function readLocalEnv(): LocalEnv | null {
  const baseUrl = process.env.DEPUSH_BASE_URL
  const appId = process.env.DEPUSH_APP_ID
  const key = process.env.DEPUSH_APP_KEY
  const secret = process.env.DEPUSH_APP_SECRET
  if (!baseUrl || !appId || !key || !secret) return null
  return { baseUrl, appId, key, secret }
}

function readCloudEnv(): CloudEnv | null {
  const appId = process.env.PUSHER_CLOUD_APP_ID
  const key = process.env.PUSHER_CLOUD_APP_KEY
  const secret = process.env.PUSHER_CLOUD_APP_SECRET
  if (!appId || !key || !secret) return null
  return { appId, key, secret }
}

const LOCAL_ENV = readLocalEnv()
const CLOUD_ENV = readCloudEnv()

function requireLocalEnv(): LocalEnv {
  if (LOCAL_ENV === null) {
    throw new Error(
      'DEPUSH_BASE_URL, DEPUSH_APP_ID, DEPUSH_APP_KEY, and DEPUSH_APP_SECRET are required',
    )
  }
  return LOCAL_ENV
}

function requireCloudEnv(): CloudEnv {
  if (CLOUD_ENV === null) {
    throw new Error(
      'PUSHER_CLOUD_APP_ID, PUSHER_CLOUD_APP_KEY, and PUSHER_CLOUD_APP_SECRET are required',
    )
  }
  return CLOUD_ENV
}

function createLocalClient(env: LocalEnv): PusherServer {
  const url = new URL(env.baseUrl)
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1) {
    throw new Error(`DEPUSH_BASE_URL must include an explicit port: ${env.baseUrl}`)
  }
  return new PusherServer({
    appId: env.appId,
    key: env.key,
    secret: env.secret,
    host: url.hostname,
    port,
    useTLS: url.protocol === 'https:',
  })
}

function createCloudClient(env: CloudEnv): PusherServer {
  return new PusherServer({
    appId: env.appId,
    key: env.key,
    secret: env.secret,
    useTLS: true,
  })
}

function channelsFor(caseId: string): Channels {
  const suffix = `${RUN_ID}-${caseId}`
  return {
    public: `compat-${suffix}`,
    cache: `cache-${suffix}`,
    presence: `presence-${suffix}`,
  }
}

function isRequestError(error: unknown): error is RequestError {
  if (typeof error !== 'object' || error === null) return false
  if (!('status' in error) || typeof error.status !== 'number') return false
  if (!('body' in error) || typeof error.body !== 'string') return false
  return true
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

async function observeCase(run: () => Promise<PusherResponse>): Promise<Observed> {
  try {
    const response = await run()
    return { status: response.status, body: await response.json() }
  } catch (error) {
    if (!isRequestError(error)) throw error
    return { status: error.status, body: parseJson(error.body) }
  }
}

function isCacheInfo(body: unknown): body is CacheInfo {
  if (typeof body !== 'object' || body === null) return false
  if (!('occupied' in body) || typeof body.occupied !== 'boolean') return false
  if (!('cache' in body) || typeof body.cache !== 'object' || body.cache === null) return false
  return (
    'data' in body.cache &&
    typeof body.cache.data === 'string' &&
    'ttl' in body.cache &&
    typeof body.cache.ttl === 'number'
  )
}

function readCacheInfo(body: unknown): CacheInfo {
  if (!isCacheInfo(body)) {
    throw new Error(`expected channel cache info, got ${JSON.stringify(body)}`)
  }
  return body
}

function assertCacheParity(local: unknown, cloud: unknown): void {
  const localInfo = readCacheInfo(local)
  const cloudInfo = readCacheInfo(cloud)

  expect(localInfo.occupied).toBe(false)
  expect(cloudInfo.occupied).toBe(false)
  expect(cloudInfo.cache.data).toBe(localInfo.cache.data)
  expect(localInfo.cache.ttl).toBeGreaterThan(0)
  expect(cloudInfo.cache.ttl).toBeGreaterThan(0)

  const data: unknown = JSON.parse(localInfo.cache.data)
  expect(data).toEqual({ hello: 'cache' })
}

const parityCases: ParityCase[] = [
  {
    id: 'publish',
    expectedStatus: 200,
    expectedBody: {},
    compareBody: true,
    run: (client, channels) => client.trigger(channels.public, 'compat-event', { hello: 'world' }),
  },
  {
    id: 'batch',
    expectedStatus: 200,
    expectedBody: {},
    compareBody: true,
    run: (client, channels) =>
      client.triggerBatch([
        { channel: channels.public, name: 'compat-batch', data: { n: 1 } },
        { channel: channels.cache, name: 'compat-batch', data: { n: 2 } },
      ]),
  },
  {
    id: 'channel-info',
    expectedStatus: 200,
    expectedBody: { occupied: false },
    compareBody: true,
    run: (client, channels) => client.get({ path: `/channels/${channels.public}` }),
  },
  {
    id: 'user-count',
    expectedStatus: 200,
    expectedBody: { occupied: false, user_count: 0 },
    compareBody: true,
    run: (client, channels) =>
      client.get({ path: `/channels/${channels.presence}`, params: { info: 'user_count' } }),
  },
  {
    id: 'users',
    expectedStatus: 200,
    expectedBody: { users: [] },
    compareBody: true,
    run: (client, channels) => client.get({ path: `/channels/${channels.presence}/users` }),
  },
  {
    id: 'cache',
    expectedStatus: 200,
    compareBody: false,
    assertBody: assertCacheParity,
    run: async (client, channels) => {
      await client.trigger(channels.cache, 'compat-cache', { hello: 'cache' })
      return client.get({ path: `/channels/${channels.cache}`, params: { info: 'cache' } })
    },
  },
  {
    id: 'channel-list',
    expectedStatus: 200,
    expectedBody: { channels: {} },
    compareBody: true,
    run: (client, channels) =>
      client.get({ path: '/channels', params: { filter_by_prefix: channels.public } }),
  },
  {
    id: 'batch-too-large',
    expectedStatus: 400,
    compareBody: false,
    run: (client, channels) =>
      client.triggerBatch(
        Array.from({ length: 11 }, (_, index) => ({
          channel: channels.public,
          name: 'compat-batch-too-large',
          data: { index },
        })),
      ),
  },
]

describe.skipIf(LOCAL_ENV === null)('pusher server SDK against local depush', () => {
  for (const testCase of parityCases) {
    it(testCase.id, async () => {
      const client = createLocalClient(requireLocalEnv())
      const observed = await observeCase(() => testCase.run(client, channelsFor(testCase.id)))

      expect(observed.status).toBe(testCase.expectedStatus)
      if (testCase.expectedBody !== undefined) {
        expect(observed.body).toEqual(testCase.expectedBody)
      }
      if (testCase.assertBody !== undefined) {
        testCase.assertBody(observed.body, observed.body)
      }
    })
  }

  it('rejects a bad signature', async () => {
    const env = requireLocalEnv()
    const body = JSON.stringify({
      name: 'compat-bad-signature',
      channel: 'compat-bad-signature',
      data: '{}',
    })
    const query = new URLSearchParams({
      auth_key: env.key,
      auth_timestamp: String(Math.floor(Date.now() / 1000)),
      auth_version: '1.0',
      body_md5: createHash('md5').update(body).digest('hex'),
      auth_signature: '0'.repeat(64),
    })

    const response = await fetch(`${env.baseUrl}/apps/${env.appId}/events?${query.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    await response.text()

    expect(response.status).toBe(401)
  })
})

describe.skipIf(LOCAL_ENV === null || CLOUD_ENV === null)(
  'pusher server SDK local and Pusher Cloud parity',
  () => {
    for (const testCase of parityCases) {
      it(testCase.id, async () => {
        const localClient = createLocalClient(requireLocalEnv())
        const cloudClient = createCloudClient(requireCloudEnv())
        const channels = channelsFor(testCase.id)

        const local = await observeCase(() => testCase.run(localClient, channels))
        const cloud = await observeCase(() => testCase.run(cloudClient, channels))

        expect(local.status).toBe(testCase.expectedStatus)
        expect(cloud.status).toBe(testCase.expectedStatus)
        if (testCase.compareBody) {
          expect(local.body).toEqual(cloud.body)
        }
        if (testCase.assertBody !== undefined) {
          testCase.assertBody(local.body, cloud.body)
        }
      })
    }

    it('rejects a bad signature', async () => {
      const env = requireCloudEnv()
      const body = JSON.stringify({
        name: 'compat-bad-signature',
        channel: `compat-${RUN_ID}-cloud-bad-signature`,
        data: '{}',
      })
      const query = new URLSearchParams({
        auth_key: env.key,
        auth_timestamp: String(Math.floor(Date.now() / 1000)),
        auth_version: '1.0',
        body_md5: createHash('md5').update(body).digest('hex'),
        auth_signature: '0'.repeat(64),
      })

      const response = await fetch(
        `${CLOUD_API_URL}/apps/${env.appId}/events?${query.toString()}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        },
      )
      await response.text()

      expect(response.status).toBe(401)
    })
  },
)
