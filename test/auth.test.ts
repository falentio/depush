import { describe, expect, it } from 'vitest'
import { verifyRequest } from '../src/auth'
import type { AppConfig } from '../src/config'
import { hmacHex, md5Hex } from '../src/signature'

const APP_ID = '3'
const APP_KEY = '278d425bdf160c739803'
const APP_SECRET = '7ad3773142a6692b25b8'
const WORKED_BODY = '{"name":"foo","channels":["project-3"],"data":"{\\"some\\":\\"data\\"}"}'
const TIMESTAMP = 1353088179

const config: AppConfig = {
  appId: APP_ID,
  key: APP_KEY,
  secret: APP_SECRET,
  activityTimeout: 120,
}

async function signedRequest(
  overrides: { signature?: string; timestamp?: number; timestampRaw?: string } = {},
) {
  const body = new TextEncoder().encode(WORKED_BODY)
  const timestamp = overrides.timestamp ?? TIMESTAMP
  const params = new URLSearchParams({
    auth_key: APP_KEY,
    auth_timestamp: overrides.timestampRaw ?? String(timestamp),
    auth_version: '1.0',
    body_md5: md5Hex(body),
  })
  const stringToSign = `POST\n/apps/${APP_ID}/events\n${params}`
  params.set('auth_signature', overrides.signature ?? (await hmacHex(APP_SECRET, stringToSign)))

  return {
    body,
    request: new Request(`http://depush.test/apps/${APP_ID}/events?${params}`, {
      method: 'POST',
      body,
    }),
  }
}

describe('verifyRequest', () => {
  it('accepts the API.md worked request', async () => {
    const { request, body } = await signedRequest()
    expect(await verifyRequest(request, body, config, TIMESTAMP)).toEqual({ ok: true })
  })

  it('rejects a tampered signature', async () => {
    const { request, body } = await signedRequest({ signature: 'f'.repeat(64) })
    expect(await verifyRequest(request, body, config, TIMESTAMP)).toMatchObject({ status: 401 })
  })

  it('rejects a timestamp outside the 600s window', async () => {
    const { request, body } = await signedRequest()
    expect(await verifyRequest(request, body, config, TIMESTAMP + 601)).toMatchObject({
      status: 401,
    })
  })

  it('accepts an all-digit timestamp', async () => {
    const { request, body } = await signedRequest({ timestampRaw: String(TIMESTAMP) })
    expect(await verifyRequest(request, body, config, TIMESTAMP)).toEqual({ ok: true })
  })

  it('rejects a timestamp with trailing characters', async () => {
    const { request, body } = await signedRequest({ timestampRaw: '123abc' })
    expect(await verifyRequest(request, body, config, 123)).toMatchObject({ status: 401 })
  })

  it('rejects a negative timestamp', async () => {
    const { request, body } = await signedRequest({ timestampRaw: '-1' })
    expect(await verifyRequest(request, body, config, TIMESTAMP)).toMatchObject({ status: 401 })
  })

  it('rejects a body that does not match body_md5', async () => {
    const { request, body } = await signedRequest()
    const tampered = new TextEncoder().encode(`${WORKED_BODY} `)
    expect(await verifyRequest(request, tampered, config, TIMESTAMP)).toMatchObject({ status: 401 })
    expect(body).not.toEqual(tampered)
  })
})
