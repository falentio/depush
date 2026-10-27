import { describe, expect, it } from 'vitest'
import { CLIENT_EVENT_LIMIT, CLIENT_EVENT_WINDOW_MS, ClientEventLimiter } from '../src/hub'
import { clientEventFrame, parseFrame } from '../src/protocol'

function parse(value: unknown) {
  return parseFrame(JSON.stringify(value))
}

describe('parseFrame client events', () => {
  it('parses a client event with object data', () => {
    expect(
      parse({ event: 'client-typing', channel: 'private-room', data: { typing: true } }),
    ).toEqual({
      ok: true,
      frame: {
        kind: 'client',
        name: 'client-typing',
        channel: 'private-room',
        data: { typing: true },
      },
    })
  })

  it('parses a client event with string data', () => {
    expect(parse({ event: 'client-typing', channel: 'private-room', data: 'hello' })).toEqual({
      ok: true,
      frame: { kind: 'client', name: 'client-typing', channel: 'private-room', data: 'hello' },
    })
  })

  it('parses a client event without data', () => {
    expect(parse({ event: 'client-typing', channel: 'private-room' })).toEqual({
      ok: true,
      frame: { kind: 'client', name: 'client-typing', channel: 'private-room', data: undefined },
    })
  })

  it('rejects an event name without the client- prefix', () => {
    expect(parse({ event: 'typing', channel: 'private-room', data: {} })).toEqual({ ok: false })
  })

  it('rejects an event name longer than 200 characters', () => {
    const event = `client-${'a'.repeat(194)}`
    expect(event.length).toBe(201)
    expect(parse({ event, channel: 'private-room', data: {} })).toEqual({ ok: false })
  })

  it('rejects a client event without a channel', () => {
    expect(parse({ event: 'client-typing', data: {} })).toEqual({ ok: false })
  })
})

describe('clientEventFrame', () => {
  it('builds a private frame without user_id', () => {
    const frame = JSON.parse(
      clientEventFrame({
        name: 'client-typing',
        channel: 'private-room',
        data: { typing: true },
        userId: undefined,
      }),
    )
    expect(frame).toEqual({
      event: 'client-typing',
      channel: 'private-room',
      data: { typing: true },
    })
  })

  it('builds a presence frame with the sender user_id at the top level', () => {
    const frame = JSON.parse(
      clientEventFrame({
        name: 'client-typing',
        channel: 'presence-room',
        data: { typing: true },
        userId: 'alice',
      }),
    )
    expect(frame).toEqual({
      event: 'client-typing',
      channel: 'presence-room',
      data: { typing: true },
      user_id: 'alice',
    })
  })

  it('keeps string data a string', () => {
    const frame = JSON.parse(
      clientEventFrame({
        name: 'client-typing',
        channel: 'private-room',
        data: '{"typing":true}',
        userId: undefined,
      }),
    )
    expect(frame.data).toBe('{"typing":true}')
  })
})

describe('ClientEventLimiter', () => {
  it('allows ten events in a window and rejects the eleventh', () => {
    const limiter = new ClientEventLimiter()
    for (let index = 0; index < CLIENT_EVENT_LIMIT; index += 1) {
      expect(limiter.allow('1.1', 0)).toBe(true)
    }
    expect(limiter.allow('1.1', 0)).toBe(false)
  })

  it('rolls the window forward', () => {
    const limiter = new ClientEventLimiter()
    for (let index = 0; index < CLIENT_EVENT_LIMIT; index += 1) {
      limiter.allow('1.1', 0)
    }
    expect(limiter.allow('1.1', CLIENT_EVENT_WINDOW_MS - 1)).toBe(false)
    expect(limiter.allow('1.1', CLIENT_EVENT_WINDOW_MS)).toBe(true)
  })

  it('keys the window by socket id', () => {
    const limiter = new ClientEventLimiter()
    for (let index = 0; index < CLIENT_EVENT_LIMIT; index += 1) {
      limiter.allow('1.1', 0)
    }
    expect(limiter.allow('1.2', 0)).toBe(true)
  })

  it('forgets a socket when it clears', () => {
    const limiter = new ClientEventLimiter()
    for (let index = 0; index < CLIENT_EVENT_LIMIT; index += 1) {
      limiter.allow('1.1', 0)
    }
    limiter.clear('1.1')
    expect(limiter.allow('1.1', 0)).toBe(true)
  })
})
