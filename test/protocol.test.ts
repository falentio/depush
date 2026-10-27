import { describe, expect, it } from 'vitest'
import type { PresenceMember } from '../src/protocol'
import {
  channelKind,
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

describe('channelKind', () => {
  it('classifies channel prefixes', () => {
    expect(channelKind('news')).toBe('public')
    expect(channelKind('private-room')).toBe('private')
    expect(channelKind('presence-room')).toBe('presence')
    expect(channelKind('private-encrypted-room')).toBe('encrypted')
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
