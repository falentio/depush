import { describe, expect, it } from 'vitest'
import { parseFrame } from '../src/protocol'

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
    expect(parseFrame('{"event":"client-typing","channel":"news"}')).toEqual({ ok: false })
  })

  it('rejects subscribe without a channel', () => {
    expect(parseFrame('{"event":"pusher:subscribe","data":{}}')).toEqual({ ok: false })
  })
})
