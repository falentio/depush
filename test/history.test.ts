import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { HISTORY_MAX_EVENTS } from '../src/channel'
import { parseHistoryQuery } from '../src/events'
import { presenceState } from '../src/protocol'

function channelStub(name: string) {
  return env.CHANNEL.get(env.CHANNEL.idFromName(name))
}

const recorded = {
  name: 'greeting',
  data: '{"hello":"world"}',
  userId: null,
  cache: false,
  ttlSeconds: 1800,
}

describe('parseHistoryQuery', () => {
  it('defaults the limit to 50 and the cursor to undefined', () => {
    expect(parseHistoryQuery(undefined, undefined)).toEqual({
      ok: true,
      query: { limit: 50, before: undefined },
    })
  })

  it('accepts the boundary limits', () => {
    expect(parseHistoryQuery('1', undefined)).toEqual({
      ok: true,
      query: { limit: 1, before: undefined },
    })
    expect(parseHistoryQuery('100', undefined)).toEqual({
      ok: true,
      query: { limit: 100, before: undefined },
    })
  })

  it('rejects a limit outside 1..100 or not numeric', () => {
    for (const raw of ['0', '101', 'ten', '-1', '1.5', '']) {
      expect(parseHistoryQuery(raw, undefined).ok).toBe(false)
    }
  })

  it('accepts a positive integer before cursor', () => {
    expect(parseHistoryQuery('25', '42')).toEqual({
      ok: true,
      query: { limit: 25, before: 42 },
    })
  })

  it('rejects an invalid before cursor', () => {
    for (const raw of ['0', 'not-a-number', '-3', '1.5', '']) {
      expect(parseHistoryQuery(undefined, raw).ok).toBe(false)
    }
  })
})

describe('presenceState', () => {
  it('dedupes by user id, sorts the ids, and counts unique members', () => {
    expect(
      presenceState([
        { userId: 'bob', userInfo: { name: 'Bob' } },
        { userId: 'alice', userInfo: { name: 'Alice' } },
        { userId: 'bob', userInfo: { name: 'Bob again' } },
      ]),
    ).toEqual({
      ids: ['alice', 'bob'],
      hash: { alice: { name: 'Alice' }, bob: { name: 'Bob' } },
      count: 2,
    })
  })

  it('returns an empty state for no members', () => {
    expect(presenceState([])).toEqual({ ids: [], hash: {}, count: 0 })
  })
})

describe('Channel history', () => {
  it('returns an empty page for a channel with no events', async () => {
    const stub = channelStub('unit-test:history-empty')
    expect(await stub.history({ limit: 50, before: undefined })).toEqual({
      events: [],
      next_cursor: null,
    })
  })

  it('lists events newest first with ISO timestamps', async () => {
    const stub = channelStub('unit-test:history-order')
    await stub.record(recorded)
    await stub.record({ ...recorded, name: 'later', data: '{"hello":"again"}' })

    const page = await stub.history({ limit: 50, before: undefined })
    expect(page.events.map((event) => event.name)).toEqual(['later', 'greeting'])
    expect(JSON.parse(page.events[0]?.data ?? 'null')).toEqual({ hello: 'again' })
    expect(page.events[0]?.id).toBeGreaterThan(page.events[1]?.id ?? 0)
    expect(new Date(page.events[0]?.published_at ?? '').toISOString()).toBe(
      page.events[0]?.published_at,
    )
    expect(page.next_cursor).toBeNull()
  })

  it('omits user_id when null and keeps it when set', async () => {
    const stub = channelStub('unit-test:history-user')
    await stub.record(recorded)
    await stub.record({ ...recorded, name: 'client-typing', userId: 'alice' })

    const page = await stub.history({ limit: 50, before: undefined })
    expect(page.events[0]?.user_id).toBe('alice')
    expect('user_id' in (page.events[1] ?? {})).toBe(false)
  })

  it('pages with before and reports the smallest id as the next cursor', async () => {
    const stub = channelStub('unit-test:history-page')
    await stub.record({ ...recorded, name: 'first' })
    await stub.record({ ...recorded, name: 'second' })
    await stub.record({ ...recorded, name: 'third' })

    const first = await stub.history({ limit: 2, before: undefined })
    expect(first.events.map((event) => event.name)).toEqual(['third', 'second'])
    expect(first.next_cursor).toBe(String(first.events[1]?.id))

    const older = Number(first.next_cursor)
    const second = await stub.history({ limit: 2, before: older })
    expect(second.events.map((event) => event.name)).toEqual(['first'])
    expect(second.next_cursor).toBeNull()
    expect(first.events.some((event) => event.id === second.events[0]?.id)).toBe(false)
  })

  it('records history for a non-cache channel and updates the cache only when asked', async () => {
    const stub = channelStub('unit-test:history-not-cached')
    await stub.record({ ...recorded, name: 'client-typing' })

    expect(await stub.snapshot()).toBeNull()
    expect((await stub.history({ limit: 50, before: undefined })).events.length).toBe(1)
  })

  it('keeps at most the newest 1000 events', async () => {
    const stub = channelStub('unit-test:history-pruned')
    await runInDurableObject(stub, async (instance) => {
      for (let index = 0; index < HISTORY_MAX_EVENTS + 2; index += 1) {
        await instance.record({ ...recorded, name: `event-${index}` })
      }
    })

    const page = await stub.history({ limit: HISTORY_MAX_EVENTS, before: undefined })
    expect(page.events.length).toBe(HISTORY_MAX_EVENTS)
    expect(page.events[0]?.name).toBe(`event-${HISTORY_MAX_EVENTS + 1}`)
    expect(page.events.at(-1)?.name).toBe('event-2')
    expect(page.next_cursor).toBeNull()
  })
})
