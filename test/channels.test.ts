import { describe, expect, it } from 'vitest'
import type { ChannelSnapshot } from '../src/events'
import { channelInfo, channelList, channelUsers, parseChannelInfo } from '../src/events'
import type { SocketState } from '../src/hub'
import { aggregateChannels } from '../src/hub'

const snapshot: ChannelSnapshot = {
  'presence-room': { subscriptionCount: 3, userIds: ['alice', 'bob'] },
  'private-room': { subscriptionCount: 2, userIds: [] },
  'public-smoke': { subscriptionCount: 1, userIds: [] },
}

const noInfo = { userCount: false, subscriptionCount: false, cache: false }
const userCount = { userCount: true, subscriptionCount: false, cache: false }
const subscriptionCount = { userCount: false, subscriptionCount: true, cache: false }
const cacheInfo = { userCount: false, subscriptionCount: false, cache: true }

describe('parseChannelInfo', () => {
  it('treats a missing or empty info as no attributes', () => {
    expect(parseChannelInfo(undefined)).toEqual({ ok: true, info: noInfo })
    expect(parseChannelInfo('')).toEqual({ ok: true, info: noInfo })
  })

  it('parses each supported attribute', () => {
    expect(parseChannelInfo('user_count')).toEqual({ ok: true, info: userCount })
    expect(parseChannelInfo('cache')).toEqual({ ok: true, info: cacheInfo })
    expect(parseChannelInfo('subscription_count,user_count')).toEqual({
      ok: true,
      info: { userCount: true, subscriptionCount: true, cache: false },
    })
  })

  it('rejects unknown attributes', () => {
    expect(parseChannelInfo('nope')).toEqual({
      ok: false,
      error: 'Unsupported info attribute: nope',
    })
    expect(parseChannelInfo('user_count,nope')).toEqual({
      ok: false,
      error: 'Unsupported info attribute: nope',
    })
  })
})

describe('channelList', () => {
  it('returns occupied channels under the prefix with user_count', () => {
    expect(channelList(snapshot, 'presence-', userCount)).toEqual({
      ok: true,
      body: { channels: { 'presence-room': { user_count: 2 } } },
    })
  })

  it('returns an empty attribute object when no info is requested', () => {
    expect(channelList(snapshot, undefined, noInfo)).toEqual({
      ok: true,
      body: {
        channels: { 'presence-room': {}, 'private-room': {}, 'public-smoke': {} },
      },
    })
  })

  it('returns an empty channel map for a prefix with no match', () => {
    expect(channelList(snapshot, 'nowhere-', noInfo)).toEqual({ ok: true, body: { channels: {} } })
  })

  it('requires a prefix that selects presence channels for user_count', () => {
    expect(channelList(snapshot, undefined, userCount)).toMatchObject({ ok: false })
    expect(channelList(snapshot, 'p', userCount)).toMatchObject({ ok: false })
  })

  it('rejects subscription_count for a presence channel', () => {
    expect(channelList(snapshot, 'presence-', subscriptionCount)).toMatchObject({ ok: false })
  })

  it('rejects cache on the list endpoint', () => {
    expect(channelList(snapshot, undefined, cacheInfo)).toEqual({
      ok: false,
      error: 'cache is only available on a single channel',
    })
    expect(channelList(snapshot, 'cache-', cacheInfo)).toMatchObject({ ok: false })
  })
})

describe('channelInfo', () => {
  it('returns occupied and the presence user count', () => {
    expect(channelInfo(snapshot, 'presence-room', userCount)).toEqual({
      ok: true,
      body: { occupied: true, user_count: 2 },
    })
  })

  it('returns occupied and the subscription count for a private channel', () => {
    expect(channelInfo(snapshot, 'private-room', subscriptionCount)).toEqual({
      ok: true,
      body: { occupied: true, subscription_count: 2 },
    })
  })

  it('reports an unknown channel as unoccupied with zero counts', () => {
    expect(channelInfo(snapshot, 'private-unknown', subscriptionCount)).toEqual({
      ok: true,
      body: { occupied: false, subscription_count: 0 },
    })
    expect(channelInfo(snapshot, 'presence-unknown', userCount)).toEqual({
      ok: true,
      body: { occupied: false, user_count: 0 },
    })
  })

  it('returns only occupied when no info is requested', () => {
    expect(channelInfo(snapshot, 'public-smoke', noInfo)).toEqual({
      ok: true,
      body: { occupied: true },
    })
  })

  it('rejects info that does not apply to the channel kind', () => {
    expect(channelInfo(snapshot, 'public-smoke', userCount)).toMatchObject({ ok: false })
    expect(channelInfo(snapshot, 'presence-room', subscriptionCount)).toMatchObject({ ok: false })
  })

  it('ignores the cache flag and leaves the payload to the route', () => {
    expect(channelInfo(snapshot, 'public-smoke', cacheInfo)).toEqual({
      ok: true,
      body: { occupied: true },
    })
    expect(channelInfo(snapshot, 'cache-unknown', cacheInfo)).toEqual({
      ok: true,
      body: { occupied: false },
    })
  })
})

describe('channelUsers', () => {
  it('returns the presence ids', () => {
    expect(channelUsers(snapshot, 'presence-room')).toEqual({
      ok: true,
      body: { users: [{ id: 'alice' }, { id: 'bob' }] },
    })
  })

  it('returns an empty list for an unoccupied presence channel', () => {
    expect(channelUsers(snapshot, 'presence-unknown')).toEqual({ ok: true, body: { users: [] } })
  })

  it('rejects non-presence channels', () => {
    expect(channelUsers(snapshot, 'private-room')).toMatchObject({ ok: false })
    expect(channelUsers(snapshot, 'public-smoke')).toMatchObject({ ok: false })
  })
})

describe('aggregateChannels', () => {
  const states: SocketState[] = [
    {
      socketId: '1.1',
      subscriptions: [
        { channel: 'presence-room', presence: { userId: 'bob', userInfo: {} } },
        { channel: 'public-smoke' },
      ],
    },
    {
      socketId: '1.2',
      subscriptions: [
        { channel: 'presence-room', presence: { userId: 'alice', userInfo: {} } },
        { channel: 'presence-room', presence: { userId: 'bob', userInfo: {} } },
      ],
    },
  ]

  it('counts subscriptions per socket and dedupes sorted presence ids', () => {
    expect(aggregateChannels(states)).toEqual({
      'presence-room': { subscriptionCount: 3, userIds: ['alice', 'bob'] },
      'public-smoke': { subscriptionCount: 1, userIds: [] },
    })
  })

  it('reports no channels without sockets', () => {
    expect(aggregateChannels([])).toEqual({})
  })
})
