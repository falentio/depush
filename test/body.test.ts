import { describe, expect, it } from 'vitest'
import { declaredBodyTooLarge, MAX_BODY_BYTES, readBodyCapped, readStreamCapped } from '../src/body'

function streamOf(bytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(16 * 1024).fill(120)
  let remaining = bytes

  return new ReadableStream({
    pull(controller) {
      if (remaining === 0) {
        controller.close()
        return
      }

      const size = Math.min(remaining, chunk.byteLength)
      remaining -= size
      controller.enqueue(chunk.slice(0, size))
    },
  })
}

describe('declaredBodyTooLarge', () => {
  it('accepts a missing or within-cap content length', () => {
    expect(declaredBodyTooLarge(null)).toBe(false)
    expect(declaredBodyTooLarge(String(MAX_BODY_BYTES))).toBe(false)
  })

  it('rejects a content length over the cap', () => {
    expect(declaredBodyTooLarge(String(MAX_BODY_BYTES + 1))).toBe(true)
    expect(declaredBodyTooLarge('300000')).toBe(true)
  })

  it('ignores a content length that is not a number', () => {
    expect(declaredBodyTooLarge('nope')).toBe(false)
  })
})

describe('readStreamCapped', () => {
  it('reads a body at exactly the cap', async () => {
    const capped = await readStreamCapped(streamOf(MAX_BODY_BYTES), MAX_BODY_BYTES)
    expect(capped.ok).toBe(true)
    if (capped.ok) expect(capped.body.byteLength).toBe(MAX_BODY_BYTES)
  })

  it('rejects a body one byte over the cap', async () => {
    expect(await readStreamCapped(streamOf(MAX_BODY_BYTES + 1), MAX_BODY_BYTES)).toEqual({
      ok: false,
    })
  })

  it('treats a missing stream as an empty body', async () => {
    expect(await readStreamCapped(null, MAX_BODY_BYTES)).toEqual({
      ok: true,
      body: new Uint8Array(0),
    })
  })
})

describe('readBodyCapped', () => {
  it('reads a request body under the cap', async () => {
    const request = new Request('http://depush.test/apps/1/events', {
      method: 'POST',
      body: '{"name":"greeting"}',
    })

    const capped = await readBodyCapped(request)
    expect(capped.ok).toBe(true)
    if (capped.ok) expect(new TextDecoder().decode(capped.body)).toBe('{"name":"greeting"}')
  })

  it('rejects a declared body over the cap without reading it', async () => {
    const request = new Request('http://depush.test/apps/1/events', {
      method: 'POST',
      headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
      body: '{}',
    })

    expect(await readBodyCapped(request)).toEqual({ ok: false })
  })
})
