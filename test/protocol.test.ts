import { describe, expect, it } from 'vitest'
import type { PresenceMember } from '../src/protocol'
import {
  cacheMiss,
  channelEvent,
  channelKind,
  isCacheChannel,
  isOversizedFrame,
  isValidChannelName,
  MAX_CHANNEL_NAME,
  MAX_FRAME_BYTES,
  memberAdded,
  memberRemoved,
  parseFrame,
  presenceSubscriptionSucceeded,
} from '../src/protocol'

const alice: PresenceMember = { userId: 'alice', userInfo: { name: 'Alice' } }
const bob: PresenceMember = { userId: 'bob', userInfo: { name: 'Bob' } }

describe('parseFrame', () => {
  it('parses ping and pong', () => {
    expect(parseFrame('{"event":"pusher:ping","data":{}}')).toEqual({
      ok: true,
      frame: { kind: 'ping' },
    })
    expect(parseFrame('{"event":"pusher:pong","data":{}}')).toEqual({
      ok: true,
      frame: { kind: 'pong' },
    })
  })

  it('parses subscribe and unsubscribe channels', () => {
    expect(parseFrame('{"event":"pusher:subscribe","data":{"channel":"news"}}')).toEqual({
      ok: true,
      frame: { kind: 'subscribe', channel: 'news' },
    })
    expect(parseFrame('{"event":"pusher:unsubscribe","data":{"channel":"news"}}')).toEqual({
      ok: true,
      frame: { kind: 'unsubscribe', channel: 'news' },
    })
  })

  it('rejects invalid JSON', () => {
    expect(parseFrame('not json')).toEqual({ ok: false })
  })

  it('rejects unknown pusher events', () => {
    expect(parseFrame('{"event":"pusher:signin","data":{}}')).toEqual({ ok: false })
  })

  it('parses subscribe with auth and channel_data', () => {
    expect(
      parseFrame(
        '{"event":"pusher:subscribe","data":{"channel":"private-room","auth":"key:sig","channel_data":"{\\"user_id\\":1}"}}',
      ),
    ).toEqual({
      ok: true,
      frame: {
        kind: 'subscribe',
        channel: 'private-room',
        auth: 'key:sig',
        channelData: '{"user_id":1}',
      },
    })
  })

  it('rejects subscribe without a channel', () => {
    expect(parseFrame('{"event":"pusher:subscribe","data":{}}')).toEqual({ ok: false })
  })
})

describe('channel names', () => {
  it('accepts the official charset', () => {
    for (const name of ['news', 'private-room', 'presence-room', 'a_b=c@d,e.f;g', 'A-1']) {
      expect(isValidChannelName(name)).toBe(true)
    }
  })

  it('accepts 200 characters and rejects 201', () => {
    expect(isValidChannelName('a'.repeat(MAX_CHANNEL_NAME))).toBe(true)
    expect(isValidChannelName('a'.repeat(MAX_CHANNEL_NAME + 1))).toBe(false)
  })

  it('rejects empty and out-of-charset names', () => {
    for (const name of ['', 'news room', 'news/room', 'news?', 'café', 'news😀']) {
      expect(isValidChannelName(name)).toBe(false)
    }
  })

  it('rejects a subscribe frame with an invalid channel name', () => {
    expect(
      parseFrame(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'news room' } })),
    ).toEqual({ ok: false })
  })
})

describe('frame size', () => {
  it('allows exactly 64 KiB and rejects one more byte', () => {
    expect(isOversizedFrame('x'.repeat(MAX_FRAME_BYTES))).toBe(false)
    expect(isOversizedFrame('x'.repeat(MAX_FRAME_BYTES + 1))).toBe(true)
  })

  it('measures UTF-8 bytes, not code units', () => {
    const frame = '€'.repeat(Math.ceil(MAX_FRAME_BYTES / 3))
    expect(frame.length).toBeLessThan(MAX_FRAME_BYTES)
    expect(isOversizedFrame(frame)).toBe(true)
  })
})

describe('channelKind', () => {
  it('classifies channel prefixes', () => {
    expect(channelKind('news')).toBe('public')
    expect(channelKind('private-room')).toBe('private')
    expect(channelKind('presence-room')).toBe('presence')
    expect(channelKind('private-encrypted-room')).toBe('encrypted')
  })

  it('keeps the kind of each cache prefix', () => {
    expect(channelKind('cache-room')).toBe('public')
    expect(channelKind('private-cache-room')).toBe('private')
    expect(channelKind('presence-cache-room')).toBe('presence')
    expect(channelKind('private-encrypted-cache-room')).toBe('encrypted')
  })
})

describe('cache channels', () => {
  it('accepts the three cache prefixes', () => {
    expect(isCacheChannel('cache-room')).toBe(true)
    expect(isCacheChannel('private-cache-room')).toBe(true)
    expect(isCacheChannel('presence-cache-room')).toBe(true)
  })

  it('rejects bare prefixes, other channels, and encrypted channels', () => {
    for (const name of [
      'cache',
      'private-cache',
      'presence-cache',
      'private-encrypted-cache-room',
      'private-room',
      'presence-room',
      'news',
    ]) {
      expect(isCacheChannel(name)).toBe(false)
    }
  })

  it('builds a cache miss frame', () => {
    expect(JSON.parse(cacheMiss('cache-room'))).toEqual({
      event: 'pusher:cache_miss',
      channel: 'cache-room',
      data: '{}',
    })
  })

  it('replays a cached event as a normal channel event', () => {
    expect(JSON.parse(channelEvent('greeting', 'cache-room', '{"hello":"world"}'))).toEqual({
      event: 'greeting',
      channel: 'cache-room',
      data: '{"hello":"world"}',
    })
  })
})

describe('presence frames', () => {
  it('builds subscription_succeeded with ids, hash, and a count of unique users', () => {
    const frame = JSON.parse(presenceSubscriptionSucceeded('presence-room', [alice, bob]))
    expect(frame.event).toBe('pusher_internal:subscription_succeeded')
    expect(frame.channel).toBe('presence-room')
    expect(typeof frame.data).toBe('string')
    expect(JSON.parse(frame.data)).toEqual({
      presence: {
        ids: ['alice', 'bob'],
        hash: { alice: { name: 'Alice' }, bob: { name: 'Bob' } },
        count: 2,
      },
    })
  })

  it('builds member_added and member_removed with data as a JSON string', () => {
    const added = JSON.parse(memberAdded('presence-room', alice))
    expect(added.event).toBe('pusher_internal:member_added')
    expect(JSON.parse(added.data)).toEqual({ user_id: 'alice', user_info: { name: 'Alice' } })

    const removed = JSON.parse(memberRemoved('presence-room', 'alice'))
    expect(removed.event).toBe('pusher_internal:member_removed')
    expect(JSON.parse(removed.data)).toEqual({ user_id: 'alice' })
  })
})
