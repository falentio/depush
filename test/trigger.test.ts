import { describe, expect, it } from 'vitest'
import { MAX_DATA_BYTES, parseTrigger } from '../src/events'

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

function trigger(overrides: Record<string, unknown> = {}) {
  return encode({ name: 'greeting', channels: ['public-smoke'], data: '{}', ...overrides })
}

describe('parseTrigger', () => {
  it('accepts a channel list', () => {
    expect(parseTrigger(trigger(), undefined)).toEqual({
      ok: true,
      trigger: {
        name: 'greeting',
        data: '{}',
        channels: ['public-smoke'],
        socketId: undefined,
      },
    })
  })

  it('accepts a singular channel with socket_id', () => {
    expect(
      parseTrigger(
        trigger({ channels: undefined, channel: 'private-room', socket_id: '1.2' }),
        undefined,
      ),
    ).toEqual({
      ok: true,
      trigger: {
        name: 'greeting',
        data: '{}',
        channels: ['private-room'],
        socketId: '1.2',
      },
    })
  })

  it('rejects info in the body', () => {
    expect(parseTrigger(trigger({ info: 'subscription_count' }), undefined)).toEqual({
      ok: false,
      status: 400,
      error: 'Single-event info is not supported',
    })
  })

  it('rejects an info query parameter', () => {
    expect(parseTrigger(trigger(), 'user_count')).toEqual({
      ok: false,
      status: 400,
      error: 'Single-event info is not supported',
    })
  })

  it('rejects an encrypted singular channel', () => {
    expect(
      parseTrigger(trigger({ channels: undefined, channel: 'private-encrypted-room' }), undefined),
    ).toEqual({
      ok: false,
      status: 400,
      error: 'Encrypted channels are not supported',
    })
  })

  it('rejects an encrypted channel in a list', () => {
    expect(
      parseTrigger(trigger({ channels: ['public-smoke', 'private-encrypted-room'] }), undefined),
    ).toEqual({
      ok: false,
      status: 400,
      error: 'Encrypted channels are not supported',
    })
  })

  it('accepts a 200-character channel and rejects 201', () => {
    expect(parseTrigger(trigger({ channels: ['a'.repeat(200)] }), undefined)).toMatchObject({
      ok: true,
    })
    expect(parseTrigger(trigger({ channels: ['a'.repeat(201)] }), undefined)).toEqual({
      ok: false,
      status: 400,
      error: 'Invalid event payload',
    })
  })

  it('rejects a channel name outside the charset', () => {
    expect(parseTrigger(trigger({ channels: ['news room'] }), undefined)).toEqual({
      ok: false,
      status: 400,
      error: 'Invalid event payload',
    })
  })

  it('rejects data over 10KB', () => {
    expect(parseTrigger(trigger({ data: 'x'.repeat(MAX_DATA_BYTES + 1) }), undefined)).toEqual({
      ok: false,
      status: 413,
      error: 'Event data exceeds 10KB',
    })
  })

  it('rejects a body that is not JSON', () => {
    expect(parseTrigger(new TextEncoder().encode('nope'), undefined)).toEqual({
      ok: false,
      status: 400,
      error: 'Body must be JSON',
    })
  })
})
