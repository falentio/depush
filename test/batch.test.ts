import { describe, expect, it } from 'vitest'
import { MAX_DATA_BYTES, parseBatch } from '../src/events'

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

function event(channel: string, data = '{}') {
  return { name: 'greeting', channel, data }
}

describe('parseBatch', () => {
  it('accepts events with a singular channel and keeps socket_id', () => {
    const result = parseBatch(
      encode({
        batch: [event('private-room'), { ...event('public-smoke'), socket_id: '1.2' }],
      }),
    )

    expect(result).toEqual({
      ok: true,
      events: [
        { name: 'greeting', channel: 'private-room', data: '{}', socketId: undefined },
        { name: 'greeting', channel: 'public-smoke', data: '{}', socketId: '1.2' },
      ],
    })
  })

  it('rejects eleven events', () => {
    const batch = Array.from({ length: 11 }, () => event('private-room'))
    expect(parseBatch(encode({ batch }))).toEqual({
      ok: false,
      status: 400,
      error: 'Invalid batch payload',
    })
  })

  it('rejects an empty batch', () => {
    expect(parseBatch(encode({ batch: [] }))).toEqual({
      ok: false,
      status: 400,
      error: 'Invalid batch payload',
    })
  })

  it('rejects an oversized data field with 413', () => {
    const result = parseBatch(
      encode({ batch: [event('private-room', 'x'.repeat(MAX_DATA_BYTES + 1))] }),
    )
    expect(result).toEqual({ ok: false, status: 413, error: 'Event data exceeds 10KB' })
  })

  it('rejects an encrypted channel', () => {
    expect(parseBatch(encode({ batch: [event('private-encrypted-room')] }))).toEqual({
      ok: false,
      status: 400,
      error: 'Encrypted channels are not supported',
    })
  })

  it('rejects per-event info', () => {
    expect(
      parseBatch(encode({ batch: [{ ...event('private-room'), info: 'subscription_count' }] })),
    ).toEqual({ ok: false, status: 400, error: 'Per-event info is not supported' })
  })

  it('rejects an event without a channel', () => {
    expect(parseBatch(encode({ batch: [{ name: 'greeting', data: '{}' }] }))).toEqual({
      ok: false,
      status: 400,
      error: 'Invalid batch payload',
    })
  })

  it('rejects a batch item that uses channels instead of channel', () => {
    expect(
      parseBatch(encode({ batch: [{ name: 'greeting', channels: ['a'], data: '{}' }] })),
    ).toEqual({ ok: false, status: 400, error: 'Invalid batch payload' })
  })

  it('rejects a body that is not JSON', () => {
    expect(parseBatch(new TextEncoder().encode('nope'))).toEqual({
      ok: false,
      status: 400,
      error: 'Body must be JSON',
    })
  })
})
