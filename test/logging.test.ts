import { exports } from 'cloudflare:workers'
import * as v from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGIN = 'http://depush.test'

const recordSchema = v.object({
  '@timestamp': v.string(),
  level: v.string(),
  message: v.string(),
  logger: v.string(),
  properties: v.record(v.string(), v.unknown()),
})

function readRecord(call: unknown[]): v.InferOutput<typeof recordSchema> {
  const line = String(call[0])
  const parsed = v.safeParse(recordSchema, JSON.parse(line))
  if (!parsed.success) throw new Error(`not a log record: ${line}`)
  return parsed.output
}

function upgrade(path: string) {
  return exports.default.fetch(`${ORIGIN}${path}`, { headers: { upgrade: 'websocket' } })
}

describe('log records', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes a refused handshake with its reason and code', async () => {
    const warn = vi.spyOn(console, 'warn')

    const response = await upgrade('/app/unknown-key?protocol=7')
    expect(response.status).toBe(101)
    response.webSocket?.accept()

    const [call] = warn.mock.calls
    expect(warn).toHaveBeenCalledOnce()
    if (call === undefined) throw new Error('the refusal wrote no warn record')
    const record = readRecord(call)
    expect(record).toMatchObject({
      level: 'WARN',
      message: 'request_refused',
      logger: 'depush.request',
      properties: {
        appKey: 'unknown-key',
        code: 4001,
        path: '/app/unknown-key',
        reason: 'unknown_app_key',
      },
    })
  })

  it('drops a record below the level bound in vitest.config.ts', async () => {
    const debug = vi.spyOn(console, 'debug')

    const response = await exports.default.fetch(`${ORIGIN}/healthz`)
    expect(response.status).toBe(200)
    expect(debug).not.toHaveBeenCalled()
  })
})
