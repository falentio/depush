import { evictDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

function channelStub(name: string) {
  return env.CHANNEL.get(env.CHANNEL.idFromName(name))
}

const cached = {
  name: 'greeting',
  data: '{"hello":"world"}',
  userId: null,
  cache: true,
  ttlSeconds: 1800,
}

describe('Channel cache', () => {
  it('reports a miss before anything is recorded', async () => {
    const stub = channelStub('unit-test:empty')
    expect(await stub.snapshot()).toBeNull()
    expect(await stub.cacheInfo()).toBeNull()
  })

  it('records a cached event and reports it with the remaining TTL', async () => {
    const stub = channelStub('unit-test:recorded')
    await stub.record(cached)

    expect(await stub.snapshot()).toEqual({ name: 'greeting', data: '{"hello":"world"}' })

    const info = await stub.cacheInfo()
    expect(info?.data).toBe('{"hello":"world"}')
    expect(info?.ttl).toBeGreaterThan(0)
    expect(info?.ttl).toBeLessThanOrEqual(1800)
  })

  it('keeps only the last recorded event', async () => {
    const stub = channelStub('unit-test:last-wins')
    await stub.record(cached)
    await stub.record({ ...cached, name: 'later', data: '{"hello":"again"}' })

    expect(await stub.snapshot()).toEqual({ name: 'later', data: '{"hello":"again"}' })
  })

  it('ignores an event recorded with the cache flag off', async () => {
    const stub = channelStub('unit-test:uncached')
    await stub.record({ ...cached, cache: false })

    expect(await stub.snapshot()).toBeNull()
  })

  it('treats an expired event as a miss and drops it', async () => {
    const stub = channelStub('unit-test:expired')
    await stub.record({ ...cached, ttlSeconds: 0 })

    expect(await stub.snapshot()).toBeNull()
    expect(await stub.cacheInfo()).toBeNull()
  })

  it('keeps the cache across a Durable Object eviction', async () => {
    const stub = channelStub('unit-test:evicted')
    await stub.record(cached)
    await evictDurableObject(stub)

    expect(await stub.snapshot()).toEqual({ name: 'greeting', data: '{"hello":"world"}' })
  })
})
